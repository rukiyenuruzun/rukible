/**
 * Basit şifre kapısı.
 *
 * Çerezde şifrenin kendisi değil, şifrenin SHA-256 özeti saklanır — böylece
 * çerezi gören biri şifreyi öğrenemez. Tek kullanıcılı bir iç araç için
 * yeterli; çok kullanıcılı bir yapıya geçilirse gerçek oturum yönetimi gerekir.
 *
 * Web Crypto kullanıyoruz çünkü proxy.ts Edge ortamında çalışır ve orada
 * node:crypto bulunmaz.
 */

export const COOKIE_NAME = "rukible_giris";

export async function tokenFor(password: string): Promise<string> {
  const data = new TextEncoder().encode(`rukible:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Zamanlama saldırılarına karşı sabit süreli karşılaştırma. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
