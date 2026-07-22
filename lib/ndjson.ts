/**
 * NDJSON akış kodlayıcı — her satır tek bir JSON nesnesi.
 *
 * Hem sayfa üreteci (app/api/generate) hem de repo modu (app/api/repo/*) aynı
 * çerçeveyi kullanır: istemci gövdeyi "\n" ile bölüp her satırı JSON.parse eder.
 * Böylece istemcideki tek bir okuma döngüsü (lib/streamChat) tüm akışları işler.
 *
 * Bilinen anahtarlar:
 *   {m} mod işareti ("create" | "edit" | "plan" | "agent")
 *   {c} sayfa HTML içeriği (üretim/düzenleme)
 *   {r} modelin düşünme metni (HTML'e KARIŞMAZ)
 *   {n} kullanıcıya gösterilecek durum notu
 *   {u} bitişte token/maliyet bilgisi
 *   {a} repo modu: asistan anlatımı (sohbet metni — sayfa HTML'i DEĞİL)
 *   {t} repo modu: araç adımı etiketi ("read_file styles.css")
 *   {w} repo modu: yazılan dosya olayı ("index.html yazıldı")
 */
export function line(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}
