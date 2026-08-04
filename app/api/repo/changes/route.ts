import { projectDir, isValidProjectId, readTextFile, workdirExists } from "@/lib/workspace";
import {
  diffFile,
  diffFileRefs,
  diffNameStatus,
  shallowBaseSha,
  untrackedFiles,
  type GitChange,
} from "@/lib/git";
import { REPO_MODE_ENABLED } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILES = 200;

export type RepoChange = {
  path: string;
  status: "added" | "modified" | "deleted";
  diff?: string;
  content?: string;
};

/**
 * GET /api/repo/changes?projectId=...
 * KLONDAN BU YANA değişen dosyaları döner (klon tabanı ↔ çalışma ağacı).
 *
 * Not: yalnızca commit'lenmemiş değişikliklere (git status) bakmıyoruz. Ajan her
 * turu bir "sürüm" olarak commit'liyor (bkz. sürüm geçmişi); o yüzden çalışma
 * ağacı çoğu zaman TEMİZ olur ama klona göre epey değişmiştir. Bu yüzden farkı
 * sığ klon tabanına (shallowBaseSha) göre alıyoruz — "Değişenler" == push'un
 * göndereceği == taban..çalışma. Böylece checkpoint'lerden bağımsız, kararlı.
 */
export async function GET(req: Request) {
  if (!REPO_MODE_ENABLED) {
    return new Response("Repo modu kapalı.", { status: 503 });
  }

  const projectId = new URL(req.url).searchParams.get("projectId") ?? "";
  if (!isValidProjectId(projectId)) {
    return new Response("Geçersiz proje kimliği.", { status: 400 });
  }
  if (!(await workdirExists(projectId))) {
    return Response.json({ files: [] });
  }

  const cwd = projectDir(projectId);

  try {
    const base = await shallowBaseSha(cwd);

    // Tabana göre izlenen dosya değişiklikleri (commit'li + commit'siz karışık).
    const tracked = base ? await diffNameStatus(cwd, [base]) : [];
    // Hâlâ izlenmeyen (yeni eklenmiş, henüz hiç commit olmamış) dosyalar.
    const trackedPaths = new Set(tracked.map((c) => c.path));
    const untracked = (await untrackedFiles(cwd)).filter(
      (p) => !trackedPaths.has(p),
    );

    const combined: Array<GitChange & { untracked?: boolean }> = [
      ...tracked,
      ...untracked.map((p) => ({ path: p, status: "added" as const, untracked: true })),
    ].slice(0, MAX_FILES);

    const files: RepoChange[] = [];
    for (const c of combined) {
      const item: RepoChange = { path: c.path, status: c.status };

      // Diff: izlenmeyen dosyada /dev/null'a karşı; izlenende tabana karşı.
      try {
        item.diff = c.untracked
          ? await diffFile(cwd, c.path, true)
          : await diffFileRefs(cwd, [base], c.path);
      } catch {
        item.diff = undefined;
      }

      // İçerik (kopyala/indir için) — silinen dosyada yok.
      if (c.status !== "deleted") {
        try {
          item.content = await readTextFile(projectId, c.path);
        } catch {
          item.content = undefined; // ikili/çok büyük — atla
        }
      }

      files.push(item);
    }

    return Response.json({ files });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "hata";
    return new Response(`Değişiklikler alınamadı: ${msg}`, { status: 500 });
  }
}
