/**
 * Git repo URL doğrulama + SSRF koruması.
 *
 * v1 sadece PUBLIC http(s) repolarını destekler. Kimlik içeren URL'ler, ssh/
 * git/file şemaları ve iç ağ adresleri reddedilir — böylece `git clone` ile
 * yerel servislere/dosya sistemine erişim (SSRF) engellenir.
 */

export type RepoUrlResult =
  | { ok: true; url: string; name: string }
  | { ok: false; error: string };

/** Yerel ağ / iç servis adreslerini engeller (fetchPage.isBlockedHost ile aynı ruh). */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
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
    h === "::1" ||
    h === ""
  );
}

/** Repo adını URL'nin son parçasından çıkarır ("owner/x.git" -> "x"). */
function repoNameFromUrl(u: URL): string {
  const last = u.pathname.split("/").filter(Boolean).pop() ?? "proje";
  return last.replace(/\.git$/i, "").slice(0, 80) || "proje";
}

export function validateGitUrl(raw: string): RepoUrlResult {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, error: "URL boş." };

  // scp benzeri git adresleri (git@host:owner/repo.git) ve şema-siz girişler.
  if (/^[^\s/]+@[^\s/]+:/.test(trimmed)) {
    return {
      ok: false,
      error: "SSH adresleri desteklenmiyor. https:// ile başlayan public bir URL ver.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Geçersiz URL." };
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    return {
      ok: false,
      error: "Sadece http/https destekleniyor (git://, ssh://, file:// değil).",
    };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "Kimlik içeren URL kabul edilmiyor (public repo ver)." };
  }
  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, error: "Bu adrese erişim engelli." };
  }

  // Temiz URL'yi yeniden kur (fragment/gereksiz kısımları at).
  const clean = `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
  return { ok: true, url: clean, name: repoNameFromUrl(parsed) };
}
