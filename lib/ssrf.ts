import { lookup } from "node:dns/promises";
import net from "node:net";

/**
 * SSRF KORUMASI — sunucunun kendi ağından içeri istek atılmasını engeller.
 *
 * Sunucu, kullanıcının verdiği adresleri çekiyor (mesajdaki URL'ler → sayfa
 * profili, repo linki → git clone). Bu, saldırganın sunucuyu kendi eline araç
 * yapabileceği klasik SSRF yüzeyi: iç servisler, bulut metadata uçları
 * (169.254.169.254) ya da localhost'taki yönetim panelleri.
 *
 * ESKİ YAKLAŞIM YETERSİZDİ: yalnızca URL'deki host METNİNE bakılıyordu.
 * Açık kalan yollar:
 *  1. IPv4-mapped IPv6: `http://[::ffff:127.0.0.1]/` — URL bunu
 *     `[::ffff:7f00:1]`e normalize eder, `/^127\./` regexi görmez.
 *  2. İç IP'ye çözülen alan adı: `localtest.me` → 127.0.0.1. Host metni masum.
 *  3. Yönlendirme: herkese açık bir adres 302 ile iç adrese atabilir.
 *  4. Alt kaynaklar: sayfadaki <link rel=stylesheet href="http://iç-adres">.
 * (Ondalık/sekizlik IPv4 — `http://2130706433/` — aslında sorun değildi:
 *  WHATWG URL ayrıştırıcısı onları 127.0.0.1'e normalize ediyor.)
 *
 * ŞİMDİKİ YAKLAŞIM: host adı ÇÖZÜLÜR, dönen TÜM adresler aralık kontrolünden
 * geçer; yönlendirmeler elle takip edilip her adım yeniden doğrulanır.
 *
 * KALAN RİSK (bilinçli): DNS rebinding. Biz çözüp doğruladıktan sonra `fetch`
 * kendi çözümlemesini yapar; çok kısa TTL ile cevabı değiştiren bir saldırgan
 * teorik olarak arayı açabilir. Kapatmak için bağlantıyı çözülmüş IP'ye
 * sabitlemek (custom dispatcher) gerekir — tek kullanıcılı yerel araç için
 * şimdilik orantısız.
 */

/** RFC1918 + loopback + link-local + CGNAT + multicast/ayrılmış aralıklar. */
function isPrivateIpv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // anlaşılmayan adres → güvenli tarafta kal
  }
  const [a, b] = p;
  return (
    a === 0 || // 0.0.0.0/8 "bu ağ"
    a === 10 || // özel
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local (bulut metadata)
    (a === 172 && b >= 16 && b <= 31) || // özel
    (a === 192 && b === 0) || // 192.0.0/24 + 192.0.2/24 (ayrılmış/test)
    (a === 192 && b === 168) || // özel
    (a === 192 && b === 88) || // 192.88.99/24 (6to4 relay, kullanımdan kalktı)
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmark
    (a === 198 && b === 51) || // 198.51.100/24 test
    (a === 203 && b === 0) || // 203.0.113/24 test
    a >= 224 // multicast (224/4) + ayrılmış (240/4) + broadcast
  );
}

/** IPv6'yı 8 gruba açar; anlaşılmazsa null. Sondaki IPv4 biçimini de çevirir. */
function expandIpv6(raw: string): number[] | null {
  let ip = raw;
  // "::ffff:127.0.0.1" → "::ffff:7f00:1"
  const dotted = ip.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted && net.isIPv4(dotted[2])) {
    const [a, b, c, d] = dotted[2].split(".").map(Number);
    ip = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g, 16));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

function isPrivateIpv6(ip: string): boolean {
  const g = expandIpv6(ip.toLowerCase().split("%")[0]);
  if (!g) return true; // çözemediysek engelle
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) ve IPv4-compatible (::a.b.c.d)
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
    return isPrivateIpv4(v4);
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 benzersiz yerel
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** Bir IP adresi iç ağa mı ait? (IP olmayan girdi güvenli tarafta engellenir.) */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) return isPrivateIpv6(ip);
  return true;
}

const BLOCKED_SUFFIXES = [".local", ".internal", ".localdomain", ".home.arpa", ".localhost"];

/** Host ADINDAN anlaşılan engelliler (çözümleme yapmadan). */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost") return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (net.isIP(h)) return isPrivateIp(h);
  // Alternatif IPv4 yazımları ("0177.0.0.1", "2130706433"): net.isIP bunları
  // IP saymaz ama URL ayrıştırıcısı 127.0.0.1'e normalize eder. Bu fonksiyon
  // tek başına da doğru cevap versin diye normalize edip tekrar bakıyoruz.
  if (/^[0-9a-fx.]+$/i.test(h)) {
    try {
      const normalized = new URL(`http://${h}/`).hostname;
      if (net.isIP(normalized)) return isPrivateIp(normalized);
    } catch {
      return true; // ayrıştırılamayan tuhaf host → güvenli tarafta kal
    }
  }
  return false;
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; error: string };

/**
 * URL'yi doğrular: şema, kimlik, host adı ve ÇÖZÜLMÜŞ TÜM IP'ler.
 * Adreslerden herhangi biri iç ağa düşüyorsa reddeder.
 */
export async function assertPublicUrl(raw: string | URL): Promise<UrlCheck> {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch {
    return { ok: false, error: "Geçersiz URL" };
  }
  if (!/^https?:$/.test(url.protocol)) {
    return { ok: false, error: "Sadece http/https destekleniyor" };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Kimlik içeren URL kabul edilmiyor" };
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(host)) {
    return { ok: false, error: "Bu adrese erişim engelli" };
  }
  if (!net.isIP(host)) {
    let addresses: { address: string }[];
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      return { ok: false, error: "Adres çözümlenemedi" };
    }
    if (!addresses.length) return { ok: false, error: "Adres çözümlenemedi" };
    if (addresses.some((a) => isPrivateIp(a.address))) {
      return { ok: false, error: "Bu adres iç ağa çözülüyor, erişim engelli" };
    }
  }
  return { ok: true, url };
}

/**
 * Doğrulanmış getirme: yönlendirmeleri ELLE takip eder ve her adımı yeniden
 * doğrular (aksi halde herkese açık bir adres 302 ile iç ağa atabilirdi).
 * Zaman aşımı tüm zinciri (gövde okuma dahil) kapsar.
 */
export async function safeFetchText(
  rawUrl: string,
  init: RequestInit = {},
  { timeoutMs = 15_000, maxRedirects = 3 }: { timeoutMs?: number; maxRedirects?: number } = {},
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const check = await assertPublicUrl(current);
      if (!check.ok) throw new Error(check.error);

      const res = await fetch(check.url, {
        ...init,
        signal: controller.signal,
        redirect: "manual",
      });

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, check.url).toString();
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    }
    throw new Error("Çok fazla yönlendirme");
  } finally {
    clearTimeout(timer);
  }
}
