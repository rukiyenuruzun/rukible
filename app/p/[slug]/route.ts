import { getDb } from "@/lib/db";

/**
 * Herkese açık paylaşım sayfası.
 *
 * Bilerek bir React sayfası değil, ham HTML döndüren bir rota:
 * böylece paylaşılan tasarım Next.js'in sarmalayıcısı olmadan,
 * üretildiği haliyle birebir görünür.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const db = getDb();
  if (!db) {
    return new Response("Paylaşım şu an kullanılamıyor.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const { slug } = await params;

  const { data, error } = await db
    .from("versions")
    .select("html")
    .eq("share_slug", slug)
    .maybeSingle();

  if (error || !data) {
    return new Response(notFoundPage(), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return new Response(data.html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Paylaşılan tasarım arama motorlarına düşmesin.
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "public, max-age=60",
    },
  });
}

function notFoundPage(): string {
  return `<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bulunamadı</title>
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#fff7f3;
       font-family:ui-sans-serif,system-ui,sans-serif;color:#78716c}
  div{text-align:center}
  p{font-size:14px;margin:.4rem 0}
  .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#fb923c}
</style></head>
<body><div>
  <span class="dot"></span>
  <p>Bu paylaşım linki geçersiz ya da kaldırılmış.</p>
</div></body></html>`;
}
