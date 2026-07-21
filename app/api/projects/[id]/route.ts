import { getDb } from "@/lib/db";

/** Bir projeyi tüm versiyonlarıyla getirir (geri alma listesi için). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getDb();
  if (!db) {
    return new Response(
      "Supabase yapılandırılmamış. .env.local dosyasına SUPABASE_SERVICE_KEY ekle.",
      { status: 503 },
    );
  }

  const { id } = await params;

  // "*" ile alıyoruz: 'chat' sütunu (migration çalıştıysa) gelir, çalışmadıysa
  // hata vermeden gelmez. Böylece kod her iki durumda da bozulmadan çalışır.
  const { data: project, error: projectError } = await db
    .from("projects")
    .select("*")
    .eq("id", id)
    .single();

  if (projectError) return new Response(projectError.message, { status: 404 });

  const { data: versions, error: versionsError } = await db
    .from("versions")
    .select("id, project_id, prompt, cost, share_slug, created_at, html")
    .eq("project_id", id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (versionsError) return new Response(versionsError.message, { status: 500 });

  return Response.json({ project, versions: versions ?? [] });
}

/**
 * Projeyi ve ona bağlı tüm versiyonları siler.
 * Versiyonlar şemada "on delete cascade" ile bağlı olduğu için otomatik gider.
 * Geri alınamaz — arayüzde iki adımlı onay var.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getDb();
  if (!db) return new Response("Supabase yapılandırılmamış.", { status: 503 });

  const { id } = await params;
  const { error } = await db.from("projects").delete().eq("id", id);

  if (error) return new Response(error.message, { status: 500 });
  return Response.json({ ok: true });
}

/** Proje başlığını değiştirir VEYA sohbeti kaydeder ({chat: [...]}). */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getDb();
  if (!db) return new Response("Supabase yapılandırılmamış.", { status: 503 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  // Sohbet kaydı: checklist'ler dahil tüm mesajlar DB'de saklanır ki her cihaz/
  // sitede (localhost, Vercel) aynı zengin sohbet görünsün.
  if (Array.isArray(body?.chat)) {
    const { error } = await db.from("projects").update({ chat: body.chat }).eq("id", id);
    // 'chat' sütunu yoksa (migration çalışmadıysa) sessizce geç — localStorage yedeği var.
    return Response.json({ ok: !error });
  }

  const title = typeof body?.title === "string" ? body.title.trim().slice(0, 120) : "";
  if (!title) return new Response("Başlık boş olamaz.", { status: 400 });

  const { error } = await db
    .from("projects")
    .update({ title, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) return new Response(error.message, { status: 500 });
  return Response.json({ ok: true });
}
