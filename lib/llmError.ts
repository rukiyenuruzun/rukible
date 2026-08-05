/**
 * LLM sağlayıcı hatalarını kullanıcıya ANLAŞILIR Türkçe mesaja çevirir.
 *
 * En sık takılınacak durum: ön ödemeli token paketinin (bkz. Qwen "token-plan")
 * BİTMESİ. Sağlayıcı kalan bakiyeyi API'den vermediği için önceden uyaramıyoruz;
 * paket bitince istekler 401/402/403/429 ya da "insufficient/quota/balance" gibi
 * bir mesajla düşer. Bunu ham teknik metin yerine net bir açıklamaya çeviriyoruz.
 *
 * Kota/anahtar dışı hatalarda `fallback` (mevcut teknik mesaj) aynen döner —
 * yani davranış yalnızca kota/yetki durumunda değişir.
 */
export function llmErrorText(err: unknown, fallback: string): string {
  const e = err as { status?: number; code?: string; message?: string };
  const status = typeof e?.status === "number" ? e.status : undefined;
  const msg = (e?.message ?? "").toLowerCase();

  const quotaCode = status === 401 || status === 402 || status === 403 || status === 429;
  const quotaText =
    /insufficient|balance|quota|exceeded|arrears|out of credit|no credit|not enough|欠费|余额/.test(
      msg,
    );

  if (quotaCode || quotaText) {
    return (
      "LLM kotası/bakiyesi bitmiş ya da anahtar reddedilmiş olabilir. " +
      "token-plan panelini veya Yiğit'i kontrol et." +
      (status ? ` (kod ${status})` : "")
    );
  }
  return fallback;
}
