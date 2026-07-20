/**
 * Yama (patch) motoru.
 *
 * Düzenleme modunda model tüm sayfayı yeniden yazmaz; sadece değiştirilecek
 * blokları şu formatta döner:
 *
 *   <<<<<<< SEARCH
 *   (mevcut metin, birebir)
 *   =======
 *   (yeni metin)
 *   >>>>>>> REPLACE
 *
 * Çıkış tokeni maliyetin %91'i olduğu için bu, düzenleme başına maliyeti
 * kabaca 10 kuruştan 1 kuruşa indirir.
 */

export type PatchOutcome = {
  html: string;
  mode: "patch" | "full" | "none";
  applied: number;
  failed: number;
  notes: string[];
};

const BLOCK_PATTERN =
  /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;

/** Satır sonu boşluklarını temizler — model bazen onları kaydırıyor. */
function normalize(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n");
}

/**
 * `raw` metnini mevcut HTML'e uygular.
 * Model kurala uymayıp tam sayfa dönerse onu da kabul ederiz (güvenli geri düşüş).
 */
export function applyPatches(current: string, raw: string): PatchOutcome {
  const trimmed = raw.trim();

  // Geri düşüş: model yama yerine tam sayfa döndüyse olduğu gibi kullan.
  if (/^<!DOCTYPE/i.test(trimmed) || /^<html/i.test(trimmed)) {
    return {
      html: trimmed,
      mode: "full",
      applied: 0,
      failed: 0,
      notes: ["Model tam sayfa döndürdü (yama beklenmişti)."],
    };
  }

  const blocks = [...trimmed.matchAll(BLOCK_PATTERN)];
  if (blocks.length === 0) {
    return {
      html: current,
      mode: "none",
      applied: 0,
      failed: 0,
      notes: ["Uygulanabilir bir değişiklik bulunamadı."],
    };
  }

  let html = current;
  let applied = 0;
  let failed = 0;
  const notes: string[] = [];

  for (const [, search, replace] of blocks) {
    if (html.includes(search)) {
      html = html.replace(search, replace);
      applied++;
      continue;
    }

    // İkinci deneme: satır sonu boşluklarını yok sayarak eşleştir.
    const normalizedHtml = normalize(html);
    const normalizedSearch = normalize(search);
    if (normalizedHtml.includes(normalizedSearch)) {
      html = normalizedHtml.replace(normalizedSearch, normalize(replace));
      applied++;
      continue;
    }

    failed++;
    const preview = search.replace(/\s+/g, " ").trim().slice(0, 60);
    notes.push(`Eşleşmedi: "${preview}…"`);
  }

  if (applied > 0) notes.unshift(`${applied} değişiklik uygulandı.`);

  return { html, mode: "patch", applied, failed, notes };
}
