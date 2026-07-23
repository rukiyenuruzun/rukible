/**
 * Şifre kapısı + oturum jetonu.
 *
 * Çerezde ARTIK şifreden türetilen bir değer YOK. Önceden çereze
 * SHA-256("rukible:" + APP_PASSWORD) yazılıyordu; bu iki ayrı açıktı:
 *
 *  1) Tuz yok ve önek kodda açık. SHA-256 kasten HIZLI bir algoritma —
 *     ekran kartıyla saniyede milyarlarca deneme yapılır. Çerezi ele geçiren
 *     biri insan seçimi bir şifreyi offline, dakikalar içinde kırabilirdi.
 *  2) Değer sabit ve süresizdi: sızan bir çerez, APP_PASSWORD değiştirilene
 *     kadar geçerli kalıcı bir anahtar demekti. İptal (revocation) yolu yoktu.
 *
 * Yerine: rastgele + son kullanma tarihli, SESSION_SECRET ile HMAC-SHA256
 * imzalanmış bir oturum jetonu (`gövde.imza`). Jetonun şifreyle hiçbir
 * matematiksel ilişkisi yok → kırılacak bir şey yok; süresi dolunca
 * kendiliğinden geçersiz olur.
 *
 * Web Crypto kullanıyoruz çünkü proxy.ts Edge ortamında çalışır ve orada
 * node:crypto bulunmaz.
 */

export const COOKIE_NAME = "rukible_giris";

/** Oturum ömrü — dolunca kullanıcı şifreyi tekrar girer. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const enc = new TextEncoder();

function toB64Url(buf: ArrayBuffer | Uint8Array): string {
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url → metin. Gövdeye yalnızca ASCII yazıyoruz, atob yeterli. */
function fromB64Url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

// İmza anahtarı isteğe bağlı olarak yeniden kullanılır (Edge'de modül kapsamı
// istekler arasında yaşar) — her istekte importKey yapmayalım.
let cachedSecret: string | null = null;
let cachedKey: Promise<CryptoKey> | null = null;

function hmacKey(secret: string): Promise<CryptoKey> {
  if (cachedSecret !== secret || !cachedKey) {
    cachedSecret = secret;
    cachedKey = crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  return cachedKey;
}

async function sign(secret: string, payload: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return toB64Url(sig);
}

/** Yeni oturum jetonu üretir: rastgele kimlik + son kullanma, HMAC imzalı. */
export async function issueSession(secret: string): Promise<string> {
  const jti = toB64Url(crypto.getRandomValues(new Uint8Array(16)));
  const payload = toB64Url(
    enc.encode(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, jti })),
  );
  return `${payload}.${await sign(secret, payload)}`;
}

/**
 * Jetonu doğrular. Sıra önemli: ÖNCE imza (gövdeye güvenmeden), sonra süre.
 * İmzası tutmayan bir gövde hiç ayrıştırılmaz.
 */
export async function verifySession(
  token: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(signature, await sign(secret, payload))) return false;
  try {
    const { exp } = JSON.parse(fromB64Url(payload)) as { exp?: unknown };
    return typeof exp === "number" && Date.now() < exp;
  } catch {
    return false;
  }
}

/**
 * Şifre karşılaştırması. İkisinin de özetini alıp sabit sürede karşılaştırırız:
 * böylece hem uzunluk hem de ilk farklı karakter zamanlamadan sızmaz.
 * (Bu özet SAKLANMAZ; sadece anlık karşılaştırma içindir.)
 */
export async function passwordMatches(attempt: string, password: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(attempt), digest(password)]);
  return safeEqual(a, b);
}

async function digest(value: string): Promise<string> {
  return toB64Url(await crypto.subtle.digest("SHA-256", enc.encode(`rukible:${value}`)));
}

/** Zamanlama saldırılarına karşı sabit süreli karşılaştırma. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
