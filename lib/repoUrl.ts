/**
 * Git repo URL doğrulama + SSRF koruması.
 *
 * v1 sadece PUBLIC http(s) repolarını destekler. Kimlik içeren URL'ler, ssh/
 * git/file şemaları ve iç ağ adresleri reddedilir — böylece `git clone` ile
 * yerel servislere/dosya sistemine erişim (SSRF) engellenir.
 */

import { assertPublicUrl } from "@/lib/ssrf";

export type RepoUrlResult =
  | { ok: true; url: string; name: string }
  | { ok: false; error: string };

/** Repo adını URL'nin son parçasından çıkarır ("owner/x.git" -> "x"). */
function repoNameFromUrl(u: URL): string {
  const last = u.pathname.split("/").filter(Boolean).pop() ?? "proje";
  return last.replace(/\.git$/i, "").slice(0, 80) || "proje";
}

export async function validateGitUrl(raw: string): Promise<RepoUrlResult> {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, error: "URL boş." };

  // scp benzeri git adresleri (git@host:owner/repo.git) ve şema-siz girişler.
  if (/^[^\s/]+@[^\s/]+:/.test(trimmed)) {
    return {
      ok: false,
      error: "SSH adresleri desteklenmiyor. https:// ile başlayan public bir URL ver.",
    };
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    return {
      ok: false,
      error: "Sadece http/https destekleniyor (git://, ssh://, file:// değil).",
    };
  }

  // Şema, kimlik, host adı ve ÇÖZÜLMÜŞ TÜM IP'ler tek yerden kontrol edilir.
  // Not: `git clone` adresi kendisi tekrar çözer; bu kontrol iç adresleri
  // eler ama teorik bir DNS rebinding aralığı kalır (bkz. lib/ssrf.ts).
  const check = await assertPublicUrl(trimmed);
  if (!check.ok) {
    return { ok: false, error: `${check.error} (public bir repo adresi ver).` };
  }
  const parsed = check.url;

  // Temiz URL'yi yeniden kur (fragment/gereksiz kısımları at).
  const clean = `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
  return { ok: true, url: clean, name: repoNameFromUrl(parsed) };
}
