import { projectDir, isValidProjectId, readTextFile, workdirExists } from "@/lib/workspace";
import { statusChanges, diffFile } from "@/lib/git";
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
 * Klondan bu yana değişen dosyaları (git status/diff) döner.
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
    const changes = (await statusChanges(cwd)).slice(0, MAX_FILES);
    const files: RepoChange[] = [];

    for (const c of changes) {
      const item: RepoChange = { path: c.path, status: c.status };

      // Diff (silinenlerde de git diff anlamlı; eklenenlerde --no-index).
      try {
        item.diff = await diffFile(cwd, c.path, c.status === "added");
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
