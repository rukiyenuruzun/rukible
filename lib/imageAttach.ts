/**
 * Sohbete iliştirilen görselin istemci tarafı hazırlığı.
 * Hem sayfa üreteci (app/yeni) hem repo modu (app/repo) aynı yardımcıyı kullanır.
 */

/**
 * Bir görsel dosyasını data URL'e çevirir. Ekran görüntüleri büyük olabiliyor;
 * uzun kenarı en fazla `maxDim` piksele indirip JPEG ile kodluyoruz — hem
 * maliyet hem de model sınırları için makul boyut.
 *
 * `keepOriginalUnder` verilirse ve dosya bu bayttan küçükse dosya HİÇ
 * dönüştürülmeden olduğu gibi okunur (format ve şeffaflık korunur). Repo modu
 * bunu kullanır: görsel projeye dosya olarak kaydedilebildiği için orijinal
 * baytlar önemli (örn. şeffaf PNG logo, JPEG'e çevrilince arkası siyah olurdu).
 */
export function fileToDataUrl(
  file: File,
  opts: { maxDim?: number; quality?: number; keepOriginalUnder?: number } = {},
): Promise<string> {
  const { maxDim = 1600, quality = 0.85, keepOriginalUnder } = opts;

  if (keepOriginalUnder && file.size <= keepOriginalUnder) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("görsel okunamadı"));
      reader.readAsDataURL(file);
    });
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (Math.max(width, height) > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("canvas yok"));
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("görsel okunamadı"));
    };
    img.src = url;
  });
}
