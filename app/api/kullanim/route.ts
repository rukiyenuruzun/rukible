import { getDb } from "@/lib/db";

/**
 * Harcama özeti.
 *
 * İki kaynak birleştiriliyor:
 *  - OpenRouter: kredinin gerçek durumu (kalan bakiye, günlük/aylık kullanım)
 *  - Bizim kayıtlarımız: bu araçla yapılan üretimlerin toplamı
 *
 * Anahtarın kendisi veya OpenRouter'ın döndürdüğü etiket ASLA istemciye
 * gönderilmiyor; sadece sayılar geçiyor.
 */
export async function GET() {
  const out: {
    kalan?: number;
    limit?: number;
    toplam?: number;
    bugun?: number;
    buAy?: number;
    uretimSayisi?: number;
    araclaHarcanan?: number;
  } = {};

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: "no-store",
      });
      if (res.ok) {
        const { data } = await res.json();
        out.kalan = data?.limit_remaining ?? undefined;
        out.limit = data?.limit ?? undefined;
        out.toplam = data?.usage ?? undefined;
        out.bugun = data?.usage_daily ?? undefined;
        out.buAy = data?.usage_monthly ?? undefined;
      }
    } catch {
      // OpenRouter'a ulaşılamadıysa sessizce geç — kendi kayıtlarımız yine döner.
    }
  }

  const db = getDb();
  if (db) {
    const { data } = await db.from("versions").select("cost");
    if (data) {
      out.uretimSayisi = data.length;
      out.araclaHarcanan = data.reduce(
        (sum, row) => sum + (Number(row.cost) || 0),
        0,
      );
    }
  }

  return Response.json(out, { headers: { "Cache-Control": "no-store" } });
}
