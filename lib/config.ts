/**
 * MODEL AYARI
 *
 * Modeli değiştirmek için sadece aşağıdaki satırı değiştir.
 * OpenRouter'daki tüm modeller çalışır: https://openrouter.ai/models
 *
 * Örnekler:
 *   "moonshotai/kimi-k3"        -> multimodal, 1M context ($3 / $15 per 1M token)
 *   "moonshotai/kimi-k2.7-code" -> kodlamaya özel, ~4x ucuz ($0.85 / $3.8)
 *   "anthropic/claude-opus-4-8" -> tasarım kalitesi en yüksek, daha pahalı
 */
export const MODEL = process.env.MODEL ?? "moonshotai/kimi-k3";

/** Yeni sayfa üretiminde izin verilen maksimum çıktı uzunluğu (token). */
export const MAX_OUTPUT_TOKENS = 16000;

/**
 * Düzenlemede izin verilen maksimum çıktı. Model sadece yama döndürdüğü için
 * çok daha küçük olabilir — hem ucuz hem de kaçak üretime karşı emniyet freni.
 */
export const MAX_EDIT_TOKENS = 4000;

/**
 * Düşünme (reasoning) seviyesi: "low" | "medium" | "high"
 *
 * Kimi K3 cevap yazmadan önce kendi kendine düşünür ve o düşünme metni de
 * çıkış tokeni olarak faturalanır ($15/1M). Sayfa üretimi çok derin akıl
 * yürütme gerektirmediği için varsayılan "low" — maliyeti belirgin düşürür.
 * Karmaşık isteklerde çıktı kalitesi yetersiz gelirse "medium" dene.
 */
export const REASONING_EFFORT = "low";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Paylaşım linklerinde kullanılacak asıl adres.
 *
 * Vercel her deploy için ayrı bir önizleme adresi üretir ve bunları kendi
 * girişiyle korur. Paylaşım linki bulunduğun adresi baz alırsa, önizleme
 * adresindeyken ürettiğin link karşı taraftan Vercel girişi ister.
 * Bu ayar tanımlıysa link her zaman asıl adresle üretilir.
 *
 * Vercel'de ortam değişkeni olarak ekle:
 *   NEXT_PUBLIC_SITE_URL = https://rukible.vercel.app
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "";
