import { getDb } from "@/lib/db";

const NOT_CONFIGURED =
  "Supabase yapılandırılmamış. .env.local dosyasına SUPABASE_SERVICE_KEY ekle.";

/** Projeleri listeler (en son güncellenen üstte). */
export async function GET() {
  const db = getDb();
  if (!db) return new Response(NOT_CONFIGURED, { status: 503 });

  const { data, error } = await db
    .from("projects")
    .select("id, title, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) return new Response(error.message, { status: 500 });
  return Response.json({ projects: data ?? [] });
}

/** Yeni proje açar. */
export async function POST(req: Request) {
  const db = getDb();
  if (!db) return new Response(NOT_CONFIGURED, { status: 503 });

  let title = "Adsız proje";
  try {
    const body = await req.json();
    if (typeof body?.title === "string" && body.title.trim()) {
      title = body.title.trim().slice(0, 120);
    }
  } catch {
    // gövde yoksa varsayılan başlıkla devam
  }

  const { data, error } = await db
    .from("projects")
    .insert({ title })
    .select("id, title, created_at, updated_at")
    .single();

  if (error) return new Response(error.message, { status: 500 });
  return Response.json({ project: data });
}
