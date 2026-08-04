import {
  diffFileRefs,
  diffNameStatus,
  logRange,
  revertToVersion,
  revParse,
  shallowBaseSha,
} from "@/lib/git";
import { isValidProjectId, projectDir, workdirExists } from "@/lib/workspace";
import { withRepoLock } from "@/lib/repoLock";
import { REPO_MODE_ENABLED } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type RepoVersion = {
  sha: string;
  short: string;
  message: string;
  at: number; // unix saniye
};

/**
 * Klon tabanı + taban..HEAD arasındaki commit'lerden geçerli SHA kümesini kurar.
 * Sürüm gezinme/fark/geri alma yalnız bu kümedeki commit'lere izin verir
 * (rastgele ref ile `git reset`/`diff` yaptırmayı önler).
 */
async function collectVersions(cwd: string): Promise<{
  base: RepoVersion | null;
  versions: RepoVersion[]; // yeni → eski (taban HARİÇ)
  head: string;
  allowed: Set<string>;
}> {
  const baseSha = await shallowBaseSha(cwd);
  const head = await revParse(cwd, "HEAD");

  const commits = baseSha ? await logRange(cwd, `${baseSha}..HEAD`) : [];
  const versions: RepoVersion[] = commits.map((c) => ({
    sha: c.sha,
    short: c.sha.slice(0, 7),
    message: c.message,
    at: c.at,
  }));

  let base: RepoVersion | null = null;
  if (baseSha) {
    const b = await logRange(cwd, baseSha);
    const info = b[0];
    base = {
      sha: baseSha,
      short: baseSha.slice(0, 7),
      message: info?.message ?? "",
      at: info?.at ?? 0,
    };
  }

  const allowed = new Set<string>(versions.map((v) => v.sha));
  if (baseSha) allowed.add(baseSha);
  return { base, versions, head, allowed };
}

/** Kısa/tam SHA girdisini izin verilen kümeye çözer; yoksa null. */
function resolveSha(input: string, allowed: Set<string>): string | null {
  const s = input.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(s)) return null;
  if (allowed.has(s)) return s;
  for (const full of allowed) if (full.startsWith(s)) return full;
  return null;
}

/**
 * GET /api/repo/versions?projectId=...
 *   → { base, versions, headSha }  (sürüm listesi)
 * GET /api/repo/versions?projectId=...&from=<sha>&to=<sha>
 *   → { files: [{path,status,diff}] }  (iki sürüm arası fark)
 */
export async function GET(req: Request) {
  if (!REPO_MODE_ENABLED) {
    return new Response("Repo modu kapalı.", { status: 503 });
  }

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  if (!isValidProjectId(projectId)) {
    return new Response("Geçersiz proje kimliği.", { status: 400 });
  }
  if (!(await workdirExists(projectId))) {
    return Response.json({ base: null, versions: [], headSha: "" });
  }

  const cwd = projectDir(projectId);

  try {
    const { base, versions, head, allowed } = await collectVersions(cwd);

    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");

    // Fark isteği: from (ve isteğe bağlı to; yoksa HEAD) arası.
    if (fromParam) {
      const from = resolveSha(fromParam, allowed);
      const to = toParam ? resolveSha(toParam, allowed) : head;
      if (!from || !to) {
        return new Response("Geçersiz sürüm.", { status: 400 });
      }
      const names = await diffNameStatus(cwd, [from, to]);
      const files = [];
      for (const c of names.slice(0, 200)) {
        let diff: string | undefined;
        try {
          diff = await diffFileRefs(cwd, [from, to], c.path);
        } catch {
          diff = undefined;
        }
        files.push({ path: c.path, status: c.status, diff });
      }
      return Response.json({ files });
    }

    return Response.json({ base, versions, headSha: head });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "hata";
    return new Response(`Sürümler alınamadı: ${msg}`, { status: 500 });
  }
}

/**
 * POST /api/repo/versions
 * Gövde: { projectId, sha }  → o sürüme döner (YIKICI DEĞİL: yeni kontrol
 * noktası olarak uygulanır, ileri geçmiş korunur). Yanıt: { ok, headSha }.
 */
export async function POST(req: Request) {
  if (!REPO_MODE_ENABLED) {
    return new Response("Repo modu bu ortamda kapalı.", { status: 503 });
  }

  let body: { projectId?: string; sha?: string };
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

  try {
    return await withRepoLock(projectId, async () => {
      const cwd = projectDir(projectId);
      const { base, versions, allowed } = await collectVersions(cwd);

      const target = resolveSha(body.sha ?? "", allowed);
      if (!target) {
        return new Response("Geçersiz sürüm.", { status: 400 });
      }

      const isBase = base?.sha === target;
      const found = versions.find((v) => v.sha === target);
      const label = isBase
        ? "Başlangıç (klon) sürümüne dönüldü"
        : `«${(found?.message ?? "").slice(0, 60)}» sürümüne dönüldü`;

      const headSha = await revertToVersion(cwd, target, label);
      return Response.json({ ok: true, headSha });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "bilinmeyen hata";
    return new Response(`Geri alma hatası: ${msg}`, { status: 500 });
  }
}
