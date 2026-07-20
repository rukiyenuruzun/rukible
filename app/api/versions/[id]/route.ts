import { getDb } from "@/lib/db";

/**
 * Tek bir versiyonu siler.
 * O versiyona ait paylaşım linki varsa o da geçersiz hale gelir.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getDb();
  if (!db) return new Response("Supabase yapılandırılmamış.", { status: 503 });

  const { id } = await params;
  const { error } = await db.from("versions").delete().eq("id", id);

  if (error) return new Response(error.message, { status: 500 });
  return Response.json({ ok: true });
}
