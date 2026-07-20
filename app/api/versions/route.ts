import { getDb } from "@/lib/db";

/** Yeni bir versiyon kaydeder (her üretim ve her düzenleme sonrası). */
export async function POST(req: Request) {
  const db = getDb();
  if (!db) {
    return new Response(
      "Supabase yapılandırılmamış. .env.local dosyasına SUPABASE_SERVICE_KEY ekle.",
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body?.projectId || typeof body.html !== "string" || !body.html.trim()) {
    return new Response("projectId ve html zorunlu.", { status: 400 });
  }

  const { data, error } = await db
    .from("versions")
    .insert({
      project_id: body.projectId,
      html: body.html,
      prompt: typeof body.prompt === "string" ? body.prompt.slice(0, 2000) : null,
      cost: typeof body.cost === "number" ? body.cost : null,
    })
    .select("id, project_id, prompt, cost, share_slug, created_at")
    .single();

  if (error) return new Response(error.message, { status: 500 });

  // Proje listesinde en son çalışılan üstte görünsün.
  await db
    .from("projects")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", body.projectId);

  return Response.json({ version: data });
}
