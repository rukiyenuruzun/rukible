import { getDb } from "@/lib/db";

const NOT_CONFIGURED =
  "Supabase yapılandırılmamış. .env.local dosyasına SUPABASE_URL ve SUPABASE_SERVICE_KEY ekle.";

/** Projeleri listeler (en son güncellenen üstte). */
export async function GET() {
  const db = getDb();
  if (!db) return new Response(NOT_CONFIGURED, { status: 503 });

  const { data, error } = await db
    .from("projects")
    .select("id, title, kind, repo_url, created_at, updated_at")
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
  let kind: "page" | "repo" = "page";
  let repoUrl: string | null = null;
  try {
    const body = await req.json();
    if (typeof body?.title === "string" && body.title.trim()) {
      title = body.title.trim().slice(0, 120);
    }
    if (body?.kind === "repo") kind = "repo";
    if (typeof body?.repo_url === "string" && body.repo_url.trim()) {
      repoUrl = body.repo_url.trim().slice(0, 500);
    }
  } catch {
    // gövde yoksa varsayılan başlıkla devam
  }

  const { data, error } = await db
    .from("projects")
    .insert({ title, kind, repo_url: repoUrl })
    .select("id, title, kind, repo_url, created_at, updated_at")
    .single();

  if (error) return new Response(error.message, { status: 500 });
  return Response.json({ project: data });
}
