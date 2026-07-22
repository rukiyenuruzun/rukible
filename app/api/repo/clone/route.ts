import { getDb } from "@/lib/db";
import { validateGitUrl } from "@/lib/repoUrl";
import { cloneRepo } from "@/lib/git";
import {
  isValidProjectId,
  projectDir,
  workdirExists,
  removeWorkdir,
  listTree,
  measureRepo,
  WorkdirError,
} from "@/lib/workspace";
import { withRepoLock } from "@/lib/repoLock";
import { stopDevServer } from "@/lib/devserver";
import { REPO_LIMITS, REPO_MODE_ENABLED } from "@/lib/config";
import type { TreeEntry } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Ağaçtan mantıklı bir açılış dosyası seç (kökte index.html öncelikli). */
function pickDefaultFile(tree: TreeEntry[]): string | undefined {
  const files = tree.filter((e) => e.type === "file").map((e) => e.path);
  if (files.includes("index.html")) return "index.html";
  const rootHtml = files.find((f) => !f.includes("/") && f.endsWith(".html"));
  if (rootHtml) return rootHtml;
  const anyIndex = files.find((f) => f.endsWith("/index.html"));
  if (anyIndex) return anyIndex;
  return files.find((f) => f.endsWith(".html"));
}

/**
 * POST /api/repo/clone
 * Gövde: { projectId?, url, refresh? }
 * Yanıt: { projectId, tree, defaultFile }
 */
export async function POST(req: Request) {
  if (!REPO_MODE_ENABLED) {
    return new Response("Repo modu bu ortamda kapalı.", { status: 503 });
  }

  let body: { projectId?: string; url?: string; refresh?: boolean };
  try {
    body = await req.json();
  } catch {
    return new Response("Geçersiz istek gövdesi.", { status: 400 });
  }

  const check = validateGitUrl(body.url ?? "");
  if (!check.ok) return new Response(check.error, { status: 400 });

  // Proje kimliği: verildiyse doğrula, yoksa DB'de aç ya da üret.
  let projectId = body.projectId;
  const db = getDb();
  if (projectId) {
    if (!isValidProjectId(projectId)) {
      return new Response("Geçersiz proje kimliği.", { status: 400 });
    }
  } else if (db) {
    // Aynı repoyu tekrar tekrar klonlayıp mükerrer proje oluşturmayı önle:
    // bu repo_url için zaten bir proje varsa onu yeniden kullan.
    const { data: existing } = await db
      .from("projects")
      .select("id")
      .eq("kind", "repo")
      .eq("repo_url", check.url)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing?.id) {
      projectId = existing.id as string;
    } else {
      const { data, error } = await db
        .from("projects")
        .insert({ title: check.name, kind: "repo", repo_url: check.url })
        .select("id")
        .single();
      // 'kind'/'repo_url' kolonları yoksa (migration çalışmadıysa) DB'siz sürdür.
      projectId = error || !data ? crypto.randomUUID() : (data.id as string);
    }
  } else {
    projectId = crypto.randomUUID();
  }

  try {
    const result = await withRepoLock(projectId, async () => {
      const dest = projectDir(projectId!);
      const exists = await workdirExists(projectId!);

      // Zaten klonlanmış ve yenileme istenmiyorsa: mevcut çalışma kopyasını
      // KORU (düzenlemeler kaybolmasın), sadece ağacı döndür. Sadece açık
      // "yenile" isteğinde ya da klasör yoksa klonla.
      if (exists && !body.refresh) {
        const tree = await listTree(projectId!);
        return { tree, defaultFile: pickDefaultFile(tree), reused: true };
      }

      // Yenilemeden önce çalışan dev sunucusunu durdur (silinecek workdir'in
      // altında yaşayan bir süreç kalmasın).
      if (exists) {
        stopDevServer(projectId!);
        await removeWorkdir(projectId!);
      }
      await cloneRepo(check.url, dest);

      // Klon sonrası boyut denetimi — sınırı aşarsa temizle.
      const { files, bytes } = await measureRepo(projectId!);
      if (files > REPO_LIMITS.maxFiles || bytes > REPO_LIMITS.maxBytes) {
        await removeWorkdir(projectId!);
        throw new WorkdirError(
          "too_large",
          `Repo çok büyük (${files} dosya, ${Math.round(bytes / 1e6)} MB). ` +
            "v1 daha küçük statik siteler için.",
        );
      }

      const tree = await listTree(projectId!);
      return { tree, defaultFile: pickDefaultFile(tree), reused: false };
    });

    return Response.json({ projectId, ...result });
  } catch (err) {
    // Yarım kalan klonu temizle.
    await removeWorkdir(projectId).catch(() => {});
    if (err instanceof WorkdirError) {
      return new Response(err.message, { status: 413 });
    }
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const detail = (e.stderr || e.message || "bilinmeyen hata").trim().slice(0, 500);
    return new Response(`Klonlama başarısız: ${detail}`, { status: 502 });
  }
}

/**
 * DELETE /api/repo/clone?projectId=...  — çalışma klasörünü siler.
 * (Proje silinirken çağrılır; DB satırını app/api/projects/[id] siler.)
 */
export async function DELETE(req: Request) {
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId || !isValidProjectId(projectId)) {
    return new Response("Geçersiz proje kimliği.", { status: 400 });
  }
  // Önce çalışan dev/önizleme sunucusunu durdur (yetim süreç/port kalmasın),
  // sonra klasörü sil.
  stopDevServer(projectId);
  await removeWorkdir(projectId).catch(() => {});
  return Response.json({ ok: true });
}
