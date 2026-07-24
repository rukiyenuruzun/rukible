import { NextResponse } from "next/server";
import { REPO_MODE_ENABLED } from "@/lib/config";
import {
  commitAll,
  currentBranch,
  pushHeadTo,
  remoteUrl,
  resetMixed,
  revParse,
  statusChanges,
} from "@/lib/git";
import { isValidProjectId, projectDir, workdirExists } from "@/lib/workspace";
import { withRepoLock } from "@/lib/repoLock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Geçerli dal adı: harf/rakamla başlayan bölümler, "/" ile ayrılabilir.
 * Baştaki "-" (seçenek gibi görünme) ve ".." (ref kaçışı) bu desene uymaz;
 * gerisini git'in kendi ref kuralları yakalar.
 */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** Hata metinlerinden token'ı temizler (git stderr'i push URL'sini basabiliyor). */
function scrub(text: string, secret: string): string {
  return secret ? text.split(secret).join("***") : text;
}

/**
 * POST /api/repo/push
 * Gövde: { projectId, message?, branch? }
 *
 * Çalışma kopyasındaki değişiklikleri tek commit yapar ve origin'e push'lar.
 * Push adresi İSTEMCİDEN ALINMAZ: klonun kendi origin remote'u kullanılır
 * (klonlarken SSRF kontrolünden geçmiş, .git yazmaya kapalı olduğu için
 * değiştirilemez). Kimlik, .env.local'deki GIT_PUSH_TOKEN ile URL'e eklenir;
 * diske/config'e yazılmaz. Push başarısız olursa commit geri alınır —
 * değişiklikler çalışma ağacında aynen kalır.
 */
export async function POST(req: Request) {
  if (!REPO_MODE_ENABLED) {
    return new Response("Repo modu bu ortamda kapalı.", { status: 503 });
  }

  let body: { projectId?: string; message?: string; branch?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Geçersiz istek gövdesi.", { status: 400 });
  }

  const projectId = body.projectId ?? "";
  if (!isValidProjectId(projectId)) {
    return new Response("Geçersiz proje kimliği.", { status: 400 });
  }
  if (!(await workdirExists(projectId))) {
    return new Response("Proje klasörü bulunamadı. Önce klonla.", { status: 404 });
  }

  // Commit mesajı: ilk satır yeter, taşmasın.
  const message =
    (body.message ?? "").trim().split("\n")[0].slice(0, 200) ||
    "Rukible düzenlemeleri";

  const now = new Date();
  const stamp =
    now.toISOString().slice(0, 10) +
    "-" +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0");
  const branch = (body.branch ?? "").trim() || `rukible/${stamp}`;
  if (!BRANCH_RE.test(branch) || branch.length > 100 || branch.endsWith(".lock")) {
    return new Response(`Geçersiz dal adı: ${branch}`, { status: 400 });
  }

  const token = process.env.GIT_PUSH_TOKEN ?? "";

  try {
    return await withRepoLock(projectId, async () => {
      const cwd = projectDir(projectId);

      const changes = await statusChanges(cwd);
      if (changes.length === 0) {
        return new Response("Gönderilecek değişiklik yok.", { status: 400 });
      }

      const origin = await remoteUrl(cwd);
      let pushUrl = origin;
      if (/^https?:\/\//i.test(origin)) {
        if (!token) {
          return new Response(
            "GIT_PUSH_TOKEN tanımlı değil. GitHub'da bir Personal Access Token " +
              "üret (repo yazma yetkili) ve .env.local dosyasına ekle:\n" +
              "GIT_PUSH_TOKEN=<token>",
            { status: 400 },
          );
        }
        const u = new URL(origin);
        // GitHub PAT için kullanıcı adı "x-access-token"; GitLab için
        // GIT_PUSH_USER=oauth2 tanımlanabilir.
        u.username = process.env.GIT_PUSH_USER || "x-access-token";
        u.password = token;
        pushUrl = u.toString();
      }

      const defaultBranch = await currentBranch(cwd);
      const oldHead = await revParse(cwd, "HEAD");
      const sha = await commitAll(cwd, message);

      try {
        await pushHeadTo(cwd, pushUrl, branch);
      } catch (err) {
        // Commit'i geri al ki "Değişenler" görünümü push öncesiyle aynı kalsın.
        await resetMixed(cwd, oldHead).catch(() => {});
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        const detail = scrub(e.stderr || e.message || "bilinmeyen hata", token);
        return new Response(`Push başarısız: ${detail}`, { status: 502 });
      }

      // GitHub'daysa hazır bir karşılaştırma/PR linki ver.
      let prUrl: string | null = null;
      try {
        const u = new URL(origin);
        if (u.hostname === "github.com" && branch !== defaultBranch) {
          const repoPath = u.pathname.replace(/\.git$/i, "").replace(/\/+$/, "");
          prUrl = `https://github.com${repoPath}/compare/${branch}?expand=1`;
        }
      } catch {
        // link üretilemedi, önemli değil
      }

      return NextResponse.json({
        ok: true,
        branch,
        sha: sha.slice(0, 7),
        direct: branch === defaultBranch,
        prUrl,
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "bilinmeyen hata";
    return new Response(`Push hatası: ${scrub(msg, token)}`, { status: 500 });
  }
}
