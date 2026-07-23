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

/**
 * "Var olan proje" (git repo) modundaki araçlı (agentic) döngünün modeli.
 *
 * Bu döngü function-calling (tool use) kullanır — model dosyaları okuyup yazmak
 * için araç çağırır. Varsayılan: kimi-k3. Ucuz olan kimi-k2.7-code araçları
 * çağırmak yerine "şimdi şunu yapıyorum" deyip duruyordu; talimatı daha iyi
 * izlediği için k3'e geçildi. Bedeli ~4x pahalı (~$3/$15 per 1M).
 *   "moonshotai/kimi-k3"           -> talimatı iyi izler (varsayılan)
 *   "moonshotai/kimi-k2.7-code"    -> çok ucuz ama araç kullanmayı atlayabiliyor
 *   "anthropic/claude-sonnet-4.5"  -> en sağlam ama pahalı
 *   "anthropic/claude-haiku-4.5"   -> ucuz Claude
 */
export const AGENT_MODEL = process.env.AGENT_MODEL ?? "moonshotai/kimi-k3";

/**
 * Repo modu yereldir (disk + git gerekir) ve KLONLANAN REPONUN KODUNU ÇALIŞTIRIR.
 *
 * Bu yüzden varsayılan KAPALI: güvenilmeyen kod çalıştıran bir özellik açıkça
 * istenmeden açılmamalı (yanlışlıkla deploy edilen bir ortamda sessizce
 * etkin kalmasın). Yerelde açmak için `.env.local` içine:
 *   REPO_MODE_ENABLED=1
 * Kapalıyken arayüz "Var olan proje" seçeneğini gizler, API'ler 503 döner.
 */
export const REPO_MODE_ENABLED = ["1", "true", "yes"].includes(
  (process.env.REPO_MODE_ENABLED ?? "").trim().toLowerCase(),
);

/** Klonlanan repoların tutulduğu kök klasör (proje kökünde, .gitignore'lu). */
export const WORKDIR_ROOT = ".rukible-workdir";

/** Repo modu emniyet sınırları (kaçak/DoS freni). */
export const REPO_LIMITS = {
  /** Klon başına en fazla dosya. */
  maxFiles: 4000,
  /** Klon başına en fazla toplam bayt. */
  maxBytes: 80 * 1024 * 1024, // 80 MB
  /** Tek bir dosyayı modele okuturken en fazla bayt. */
  maxReadBytes: 256 * 1024, // 256 KB
  /** write_file ile yazılabilecek en fazla bayt. */
  maxWriteBytes: 512 * 1024, // 512 KB
  /** git clone zaman aşımı (ms). */
  cloneTimeoutMs: 90_000,
  /** Araçlı döngüde en fazla model turu. */
  maxTurns: 16,
  /** Araçlı döngüde toplam en fazla araç çağrısı. */
  maxToolCalls: 60,
} as const;

/** Repo modu araçlı döngüsünde tur başına maksimum çıktı tokeni. */
export const MAX_AGENT_TOKENS = 8000;

/** Yeni sayfa üretiminde izin verilen maksimum çıktı uzunluğu (token). */
export const MAX_OUTPUT_TOKENS = 16000;

/**
 * Düzenlemede izin verilen maksimum çıktı. Model sadece yama döndürdüğü için
 * çok daha küçük olabilir — hem ucuz hem de kaçak üretime karşı emniyet freni.
 */
export const MAX_EDIT_TOKENS = 4000;

/**
 * Plan modunda çıktı sınırı. Plan kısa metindir; kod üretilmez. Uzun tutmaya
 * gerek yok, hem ucuz hem odaklı kalsın.
 */
export const MAX_PLAN_TOKENS = 2000;

/**
 * Düşünme (reasoning) seviyesi: "low" | "medium" | "high"
 *
 * Kimi K3 cevap yazmadan önce kendi kendine düşünür ve o düşünme metni de
 * çıkış tokeni olarak faturalanır ($15/1M). Net ve mekanik istekler derin akıl
 * yürütme gerektirmediği için taban seviye "low" — maliyeti düşük tutar.
 *
 * Belirsiz/öznel ("biraz canlandır") veya çok parçalı istekler ise yorum ister;
 * bu durumda seviye otomatik REASONING_EFFORT_HARD'a yükselir (bkz. lib/intent.ts).
 * Düzenlemede çıktı zaten minik olduğu için bu, anlama kalitesini az maliyetle
 * artırır.
 */
export const REASONING_EFFORT = "low";
export const REASONING_EFFORT_HARD = "medium";

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
