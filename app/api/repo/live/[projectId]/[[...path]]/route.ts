import { isValidProjectId } from "@/lib/workspace";
import { previewPort } from "@/lib/devserver";
import { rewriteHtml, rewriteCss } from "@/lib/previewRewrite";
import { REPO_MODE_ENABLED } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ÇATI ÖNİZLEMESİ PROXY'Sİ
 *
 * Çalışan dev sunucusunu (127.0.0.1:<port>) Rukible'ın kendi origin'i üzerinden
 * sunar: iframe `/api/repo/live/<id>/...`'e bakar (aynı origin → hangi tünelle
 * erişiyorsan onunla çalışır; ayrı port yönlendirmesi/devtunnels alt-alanı
 * gerekmez).
 *
 * - Upstream'e Host=localhost göndeririz → uygulamanın Host-tabanlı yönlendirme
 *   döngüleri tetiklenmez (curl'de Host=localhost temiz çalışıyor).
 * - X-Frame-Options / CSP gibi framing engelleri sıyrılır.
 * - HTML/CSS'teki kök-göreli url'ler (/_next, /tr ...) proxy yoluna yeniden
 *   yazılır (rewriteHtml/rewriteCss).
 */

const DROP_REQ = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "content-length",
]);

const DROP_RESP = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

// basePath modu tespiti (proje başına, önbellekli). Uygulama next.config'te
// RUKIBLE_BASE_PATH'i basePath olarak kullanıyorsa app'i /api/repo/live/<id>/
// altında sunar → o zaman tam yolu iletiriz ve HTML'i YENİDEN YAZMAYIZ (uygulama
// zaten hepsini bu ön ekle üretir; client router doğru çalışır = etkileşim gelir).
const bpCache = new Map<string, boolean>();
async function usesBasePath(port: number, base: string): Promise<boolean> {
  const key = base;
  const cached = bpCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${base}`, {
      redirect: "manual",
      headers: { host: `localhost:${port}` },
      signal: AbortSignal.timeout(5000),
    });
    const uses = res.status !== 404;
    bpCache.set(key, uses);
    return uses;
  } catch {
    return false;
  }
}

async function handle(
  req: Request,
  { params }: { params: Promise<{ projectId: string; path?: string[] }> },
) {
  if (!REPO_MODE_ENABLED) return new Response("Repo modu kapalı.", { status: 503 });

  const { projectId, path: segs = [] } = await params;
  if (!isValidProjectId(projectId)) {
    return new Response("Geçersiz proje.", { status: 400 });
  }

  const port = previewPort(projectId);
  const base = `/api/repo/live/${projectId}`;
  const bp = await usesBasePath(port, base);
  const rel = segs.map((s) => encodeURIComponent(s)).join("/");
  const search = new URL(req.url).search;
  // rel boşken fazladan trailing slash EKLEME (yoksa app 308 döngüsü olur).
  const target = bp
    ? `http://127.0.0.1:${port}${base}${rel ? "/" + rel : ""}${search}`
    : `http://127.0.0.1:${port}/${rel}${search}`;

  const headers = new Headers();
  req.headers.forEach((v, k) => {
    if (!DROP_REQ.has(k.toLowerCase())) headers.set(k, v);
  });
  // Host=localhost: uygulamanın marka/dil middleware'i temiz davransın.
  headers.set("host", `localhost:${port}`);
  headers.set("x-forwarded-host", `localhost:${port}`);
  headers.set("x-forwarded-proto", "http");
  headers.set("accept-encoding", "identity");

  const method = req.method.toUpperCase();
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer(),
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "hata";
    return new Response(
      `Önizleme sunucusuna ulaşılamadı (dev sunucusu çalışmıyor olabilir): ${msg}`,
      { status: 502 },
    );
  }

  const respHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!DROP_RESP.has(k.toLowerCase())) respHeaders.set(k, v);
  });
  // Önizleme yanıtları asla önbelleğe alınmasın (aksi halde eski/yanlış içerik
  // takılı kalabiliyor).
  respHeaders.set("cache-control", "no-store");

  const status = upstream.status;

  // Yönlendirmeleri proxy yoluna sabitle.
  if (status >= 300 && status < 400) {
    let loc = upstream.headers.get("location") ?? "";
    loc = loc.replace(/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i, "");
    // basePath modunda Location zaten base'i içerir; değilse base ekle.
    if (!bp && loc.startsWith("/") && !loc.startsWith("//")) loc = base + loc;
    respHeaders.set("location", loc);
    return new Response(null, { status, headers: respHeaders });
  }

  const ctype = upstream.headers.get("content-type") ?? "";
  if (ctype.includes("text/html")) {
    const raw = await upstream.text();
    // basePath modunda uygulama zaten proxy ön ekini kullanır → yeniden yazma.
    const body = bp ? raw : rewriteHtml(raw, base);
    return new Response(body, { status, headers: respHeaders });
  }
  if (ctype.includes("text/css")) {
    const raw = await upstream.text();
    const body = bp ? raw : rewriteCss(raw, base);
    return new Response(body, { status, headers: respHeaders });
  }

  const buf = await upstream.arrayBuffer();
  return new Response(buf, { status, headers: respHeaders });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
