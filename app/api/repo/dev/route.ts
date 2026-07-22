import { isValidProjectId, workdirExists } from "@/lib/workspace";
import { detectFrontend } from "@/lib/detectFrontend";
import { startDevServer, getDevServer, stopDevServer } from "@/lib/devserver";
import { REPO_MODE_ENABLED } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Çatı önizlemesi kontrolü.
 *   POST   {projectId}          -> frontend'i bul + install/dev başlat
 *   GET    ?projectId=...       -> durum + loglar (istemci poll eder)
 *   DELETE ?projectId=...       -> durdur
 *
 * UYARI: bu, klonlanan reponun kodunu çalıştırır (v1 tek-kullanıcı/yerel).
 */
export async function POST(req: Request) {
  if (!REPO_MODE_ENABLED) return new Response("Repo modu kapalı.", { status: 503 });

  let body: { projectId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Geçersiz gövde.", { status: 400 });
  }
  const projectId = body.projectId ?? "";
  if (!isValidProjectId(projectId)) {
    return new Response("Geçersiz proje kimliği.", { status: 400 });
  }
  if (!(await workdirExists(projectId))) {
    return new Response("Proje klasörü yok.", { status: 404 });
  }

  const target = await detectFrontend(projectId);
  if (!target) {
    return new Response(
      "Çalıştırılabilir bir frontend bulunamadı (dev scripti olan bir çatı projesi yok).",
      { status: 422 },
    );
  }

  const ds = await startDevServer(projectId, target);
  return Response.json({
    status: ds.status,
    port: ds.port,
    subdir: ds.subdir,
    framework: ds.framework,
    packageManager: ds.packageManager,
  });
}

export async function GET(req: Request) {
  if (!REPO_MODE_ENABLED) return new Response("Repo modu kapalı.", { status: 503 });
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "";
  if (!isValidProjectId(projectId)) {
    return new Response("Geçersiz proje kimliği.", { status: 400 });
  }
  const ds = getDevServer(projectId);
  if (!ds) return Response.json({ status: "stopped", logs: [] });
  return Response.json({
    status: ds.status,
    port: ds.port,
    subdir: ds.subdir,
    framework: ds.framework,
    error: ds.error,
    logs: ds.logs.slice(-60),
  });
}

export async function DELETE(req: Request) {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "";
  if (!isValidProjectId(projectId)) {
    return new Response("Geçersiz proje kimliği.", { status: 400 });
  }
  stopDevServer(projectId);
  return Response.json({ ok: true });
}
