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
 * BOŞLUĞA DAYANIKLI EŞLEŞTİRME (son çare).
 *
 * Model, düzenlenecek metni birebir kopyalamak yerine sık sık boşlukları/
 * girintileri değiştirir (çok satırlı class'ları tek satıra toplar, girintiyi
 * kaydırır). O zaman hiçbir blok tutmaz ve düzenleme "uygulanamadı" görünür.
 *
 * Burada hem sayfayı hem aranan metni "tüm boşluk dizisi = tek boşluk" haline
 * getirip eşleştiriyoruz; ama değişikliği ORİJİNAL sayfaya uygulayabilmek için
 * her normalize karakterin orijinal konumunu bir haritada tutuyoruz. Böylece
 * eşleşen bölgeyi orijinalde bulup yalnızca onu değiştiriyoruz; sayfanın geri
 * kalanı bozulmadan kalıyor.
 *
 * Eşleşme yoksa null döner (güvenli: hiçbir şey değişmez).
 */
// Yanındaki boşluğun HTML'de anlamsız olduğu sınır karakterleri.
const BOUNDARY = new Set(["<", ">", "=", '"', "'", "/"]);

/**
 * Metni HTML-farkında normalize eder: boşluk dizilerini teke indirir, ayrıca
 * bir etiket sınırı karakterine (< > = " ' /) komşu boşlukları tamamen atar
 * (çünkü `"\n  >` ile `">` HTML'de aynıdır). Metin içi kelime boşlukları korunur.
 *
 * withMap=true ise her normalize karakterin orijinal metindeki indeksini de döner.
 */
function htmlNormalize(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      const last = norm[norm.length - 1];
      // Boşluğu yalnızca iki kelime karakteri arasında koru.
      if (last && !BOUNDARY.has(last) && !BOUNDARY.has(ch)) {
        norm += " ";
        map.push(i);
      }
      pendingSpace = false;
    }
    norm += ch;
    map.push(i);
  }
  return { norm, map };
}

function fuzzyReplace(
  html: string,
  search: string,
  replace: string,
): string | null {
  const normSearch = htmlNormalize(search).norm;
  if (!normSearch) return null;

  const { norm, map } = htmlNormalize(html);

  const idx = norm.indexOf(normSearch);
  if (idx === -1) return null;
  // İkinci bir eşleşme varsa benzersiz değildir — yanlış yeri değiştirmemek için
  // vazgeç (güvenli tarafta kal).
  if (norm.indexOf(normSearch, idx + 1) !== -1) return null;

  const startOrig = map[idx];
  // normSearch sınır karakterine komşu boşlukla bitmez; son karakter konumu güvenli.
  const endOrig = map[idx + normSearch.length - 1] + 1;
  return html.slice(0, startOrig) + replace + html.slice(endOrig);
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

    // Üçüncü deneme: tüm boşluk farklarını yok sayarak eşleştir (son çare).
    const fuzzy = fuzzyReplace(html, search, replace);
    if (fuzzy !== null) {
      html = fuzzy;
      applied++;
      continue;
    }

    failed++;
    const preview = search.replace(/\s+/g, " ").trim().slice(0, 60);
    notes.push(`Eşleşmedi: "${preview}…"`);
  }

  // Not: "N değişiklik uygulandı" özetini bilerek eklemiyoruz — arayüz artık
  // modelin döndürdüğü madde madde değişiklik listesini gösteriyor. Burada
  // yalnızca tutmayan bloklar için tanı notları kalır.
  return { html, mode: "patch", applied, failed, notes };
}
