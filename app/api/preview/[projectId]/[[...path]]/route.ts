import {
  isValidProjectId,
  readAsset,
  isDirectory,
  workdirExists,
  WorkdirError,
} from "@/lib/workspace";
import { rewriteHtml, rewriteCss } from "@/lib/previewRewrite";
import { REPO_MODE_ENABLED } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
};

function contentType(rel: string): string {
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[ext] ?? "application/octet-stream";
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/preview/<projectId>/<...path>
 * Klonlanan repodaki dosyayı sunar. HTML/CSS'te kök-göreli url'ler düzeltilir.
 * iframe bu rotayı `src` ile gösterir; alt kaynaklar (css/js/görsel) buraya döner.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ projectId: string; path?: string[] }> },
) {
  if (!REPO_MODE_ENABLED) {
    return new Response("Repo modu kapalı.", { status: 503 });
  }

  const { projectId, path: segs = [] } = await params;
  if (!isValidProjectId(projectId)) {
    return new Response("Geçersiz proje.", { status: 400 });
  }
  if (!(await workdirExists(projectId))) {
    return new Response(notFound("Proje henüz klonlanmadı."), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE },
    });
  }

  // Boş yol ya da klasör → index.html
  let segments = segs.filter((s) => s.length > 0);
  if (segments.length === 0 || (await isDirectory(projectId, segments))) {
    segments = [...segments, "index.html"];
  }

  const base = `/api/preview/${projectId}`;

  try {
    const { buffer } = await readAsset(projectId, segments);
    const type = contentType(segments.join("/"));

    if (type.startsWith("text/html")) {
      const body = rewriteHtml(buffer.toString("utf8"), base);
      return new Response(body, {
        headers: { "Content-Type": type, ...NO_STORE },
      });
    }
    if (type.startsWith("text/css")) {
      const body = rewriteCss(buffer.toString("utf8"), base);
      return new Response(body, {
        headers: { "Content-Type": type, ...NO_STORE },
      });
    }

    return new Response(new Uint8Array(buffer), {
      headers: { "Content-Type": type, ...NO_STORE },
    });
  } catch (err) {
    if (err instanceof WorkdirError && err.code === "not_found") {
      return new Response(notFound(`Bulunamadı: /${segments.join("/")}`), {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE },
      });
    }
    if (err instanceof WorkdirError) {
      return new Response(err.message, { status: 403, headers: NO_STORE });
    }
    const msg = err instanceof Error ? err.message : "hata";
    return new Response(`Önizleme hatası: ${msg}`, { status: 500, headers: NO_STORE });
  }
}

function notFound(msg: string): string {
  return `<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>404</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#fff7f3;
font-family:ui-sans-serif,system-ui,sans-serif;color:#78716c}p{font-size:14px}</style></head>
<body><p>${msg.replace(/[<>&]/g, "")}</p></body></html>`;
}
