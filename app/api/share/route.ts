import { getDb, makeSlug, dbError } from "@/lib/db";

/**
 * Bir versiyonu herkese açık hale getirir ve paylaşılabilir bir kod üretir.
 * Kod tahmin edilemez olduğu için, linki bilmeyen kimse sayfaya ulaşamaz.
 */
export async function POST(req: Request) {
  const db = getDb();
  if (!db) {
    return new Response(
      "Supabase yapılandırılmamış. .env.local dosyasına SUPABASE_URL ve SUPABASE_SERVICE_KEY ekle.",
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body?.versionId) return new Response("versionId zorunlu.", { status: 400 });

  // Zaten paylaşılmışsa aynı linki geri ver — her basışta yeni link üretme.
  const { data: existing } = await db
    .from("versions")
    .select("share_slug")
    .eq("id", body.versionId)
    .single();

  if (existing?.share_slug) {
    return Response.json({ slug: existing.share_slug, reused: true });
  }

  const slug = makeSlug();
  const { error } = await db
    .from("versions")
    .update({ share_slug: slug })
    .eq("id", body.versionId);

  if (error) return dbError("share.create", error, "Paylaşım linki oluşturulamadı.");
  return Response.json({ slug, reused: false });
}

/** Paylaşımı geri alır — link artık çalışmaz. */
export async function DELETE(req: Request) {
  const db = getDb();
  if (!db) return new Response("Supabase yapılandırılmamış.", { status: 503 });

  const body = await req.json().catch(() => null);
  if (!body?.versionId) return new Response("versionId zorunlu.", { status: 400 });

  const { error } = await db
    .from("versions")
    .update({ share_slug: null })
    .eq("id", body.versionId);

  if (error) return dbError("share.revoke", error, "Paylaşım kaldırılamadı.");
  return Response.json({ ok: true });
}
