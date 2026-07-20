import * as cheerio from "cheerio";

/**
 * Verilen URL'deki sayfayı çeker ve modele verilebilecek özet bir profil çıkarır.
 * Amaç sayfanın tamamını göndermek değil — token maliyetini kontrol altında tutmak
 * için sadece yapı, metin ve tasarım sinyallerini süzüyoruz.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_TEXT_CHARS = 6_000;
const MAX_HEADINGS = 60;
const MAX_STYLESHEETS = 2;
const MAX_CSS_CHARS = 120_000;

/** URL'leri mesaj metninden ayıklar. */
export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"')]+/gi) ?? [];
  return [...new Set(matches)];
}

/** Yerel ağ / iç servis adreslerine istek atılmasını engeller. */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    h === "0.0.0.0" ||
    h === "[::1]"
  );
}

async function get(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,text/css,*/*" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** CSS metninden renk ve font sinyallerini çıkarır. */
function readDesignTokens(css: string) {
  const colorCounts = new Map<string, number>();
  const colorPattern = /#[0-9a-f]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\)/gi;
  // Şeffaf değerler tasarım sinyali taşımaz, listeyi şişirir.
  const isTransparent = (c: string) =>
    /^#(0{3,4}|0{6}|0{8})$/.test(c) || /^rgba?\(0,0,0,0\)$/.test(c);

  for (const raw of css.match(colorPattern) ?? []) {
    const key = raw.toLowerCase().replace(/\s+/g, "");
    if (isTransparent(key)) continue;
    colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
  }

  const colors = [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([color, count]) => `${color} (${count}x)`);

  const fonts = [
    ...new Set(
      (css.match(/font-family\s*:\s*([^;}]+)/gi) ?? [])
        .map((d) => d.replace(/font-family\s*:\s*/i, "").trim())
        .filter((f) => !f.startsWith("var("))
        .slice(0, 8),
    ),
  ];

  // Tasarım sistemi değişkenleri (--brand: #e11d48 gibi) en değerli sinyal.
  // --tw-* Tailwind'in iç değişkenleri, tasarım hakkında bilgi vermez.
  const vars = [
    ...new Set(
      (css.match(/--[\w-]+\s*:\s*[^;}]{1,60}/g) ?? [])
        .map((v) => v.trim())
        .filter((v) => /#|rgb|hsl|oklch/i.test(v))
        .filter((v) => !v.startsWith("--tw-"))
        .filter((v) => !isTransparent(v.split(":")[1]?.trim().toLowerCase() ?? "")),
    ),
  ].slice(0, 24);

  return { colors, fonts, vars };
}

export type PageProfile = {
  url: string;
  ok: boolean;
  error?: string;
  title?: string;
  description?: string;
  headings?: string[];
  text?: string;
  colors?: string[];
  fonts?: string[];
  cssVars?: string[];
};

export async function fetchPageProfile(rawUrl: string): Promise<PageProfile> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { url: rawUrl, ok: false, error: "Geçersiz URL" };
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    return { url: rawUrl, ok: false, error: "Sadece http/https destekleniyor" };
  }
  if (isBlockedHost(parsed.hostname)) {
    return { url: rawUrl, ok: false, error: "Bu adrese erişim engelli" };
  }

  let html: string;
  try {
    html = await get(parsed.toString());
  } catch (err) {
    const reason = err instanceof Error ? err.message : "bilinmeyen hata";
    return { url: rawUrl, ok: false, error: `Sayfa alınamadı (${reason})` };
  }

  const $ = cheerio.load(html);

  $("script, noscript, svg, iframe").remove();

  const title = $("title").first().text().trim() || undefined;
  const description =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    undefined;

  const headings: string[] = [];
  $("h1, h2, h3").each((_, el) => {
    if (headings.length >= MAX_HEADINGS) return;
    const tag = el.tagName.toLowerCase();
    const value = $(el).text().replace(/\s+/g, " ").trim();
    if (value) headings.push(`${tag.toUpperCase()}: ${value}`);
  });

  // Menü/footer/çerez uyarısı sayfanın içeriği değil — metni şişirir, sinyali bozar.
  const $content = cheerio.load($.html());
  $content('nav, footer, [class*="cookie"], [id*="cookie"], [class*="consent"]').remove();

  // Düz .text() bütün metni birleştirip "PazaraAI" gibi bitişik çöp üretiyor.
  // Anlamlı bloklardan tek tek toplayıp satırlara ayırmak çok daha okunur.
  const seen = new Set<string>();
  const blocks: string[] = [];
  $content("h1, h2, h3, h4, p, li, td, th, dt, dd, blockquote, figcaption").each(
    (_, el) => {
      const value = $content(el).text().replace(/\s+/g, " ").trim();
      if (value.length < 2 || value.length > 400) return;
      if (seen.has(value)) return; // aynı metin tekrar tekrar yazılmasın
      seen.add(value);
      blocks.push(value);
    },
  );

  const text = blocks.join("\n").slice(0, MAX_TEXT_CHARS);

  // Stil bilgisi: sayfa içi <style> blokları + ilk birkaç harici stylesheet.
  let css = $("style")
    .map((_, el) => $(el).text())
    .get()
    .join("\n");

  const hrefs = $('link[rel="stylesheet"]')
    .map((_, el) => $(el).attr("href"))
    .get()
    .filter((h): h is string => Boolean(h))
    .slice(0, MAX_STYLESHEETS);

  const sheets = await Promise.allSettled(
    hrefs.map((href) => get(new URL(href, parsed).toString(), 8_000)),
  );
  for (const sheet of sheets) {
    if (sheet.status === "fulfilled") css += "\n" + sheet.value;
    if (css.length > MAX_CSS_CHARS) break;
  }

  const { colors, fonts, vars } = readDesignTokens(css.slice(0, MAX_CSS_CHARS));

  return {
    url: parsed.toString(),
    ok: true,
    title,
    description,
    headings,
    text,
    colors,
    fonts,
    cssVars: vars,
  };
}

/** Profili modele verilecek okunabilir bir bloğa çevirir. */
export function profileToPrompt(p: PageProfile): string {
  if (!p.ok) {
    return `[Referans sayfa alınamadı: ${p.url} — ${p.error}.
Bu sayfanın içeriğini TAHMİN ETME. Kullanıcıya sayfaya erişilemediğini bildir.]`;
  }

  const parts = [`REFERANS SAYFA: ${p.url}`];
  if (p.title) parts.push(`Başlık: ${p.title}`);
  if (p.description) parts.push(`Açıklama: ${p.description}`);
  if (p.headings?.length) parts.push(`Başlık yapısı:\n${p.headings.join("\n")}`);
  if (p.colors?.length) parts.push(`Sık kullanılan renkler: ${p.colors.join(", ")}`);
  if (p.fonts?.length) parts.push(`Fontlar: ${p.fonts.join(" | ")}`);
  if (p.cssVars?.length) parts.push(`Tasarım değişkenleri: ${p.cssVars.join("; ")}`);
  if (p.text) parts.push(`Sayfa metni (kısaltılmış):\n${p.text}`);

  return parts.join("\n\n");
}
