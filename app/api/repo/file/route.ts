import {
  isValidProjectId,
  readTextFile,
  writeTextFile,
  WorkdirError,
} from "@/lib/workspace";
import { withRepoLock } from "@/lib/repoLock";
import { REPO_MODE_ENABLED } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Elle dosya düzenleme.
 *   GET ?projectId=...&path=...   -> { path, content }
 *   PUT { projectId, path, content } -> { ok: true }
 *
 * Yol güvenliği, boyut sınırı ve yazım yasakları (.git, .env) lib/workspace
 * içindeki yardımcılarda; burada sadece HTTP kabuğu var.
 */

/** WorkdirError kodunu HTTP durumuna çevirir. */
function statusFor(code: string): number {
  switch (code) {
    case "not_found":
      return 404;
    case "denied":
      return 403;
    case "too_large":
      return 413;
    case "binary":
      return 415;
    default:
      return 400;
  }
}

function fail(err: unknown): Response {
  if (err instanceof WorkdirError) {
    return new Response(err.message, { status: statusFor(err.code) });
  }
  console.error("[repo.file]", err);
  return new Response("Dosya işlemi başarısız.", { status: 500 });
}

export async function GET(req: Request) {
  if (!REPO_MODE_ENABLED) return new Response("Repo modu kapalı.", { status: 503 });

  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  const path = url.searchParams.get("path") ?? "";
  if (!isValidProjectId(projectId)) {
    return new Response("Geçersiz proje kimliği.", { status: 400 });
  }
  if (!path) return new Response("path zorunlu.", { status: 400 });

  try {
    return Response.json({ path, content: await readTextFile(projectId, path) });
  } catch (err) {
    return fail(err);
  }
}

export async function PUT(req: Request) {
  if (!REPO_MODE_ENABLED) return new Response("Repo modu kapalı.", { status: 503 });

  let body: { projectId?: string; path?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Geçersiz istek gövdesi.", { status: 400 });
  }

  const { projectId = "", path = "", content } = body;
  if (!isValidProjectId(projectId)) {
    return new Response("Geçersiz proje kimliği.", { status: 400 });
  }
  if (!path) return new Response("path zorunlu.", { status: 400 });
  if (typeof content !== "string") {
    return new Response("content zorunlu.", { status: 400 });
  }

  try {
    // Ajan aynı anda yazıyor olabilir; klon/ajan ile aynı kilidi paylaş.
    await withRepoLock(projectId, () => writeTextFile(projectId, path, content));
    return Response.json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
