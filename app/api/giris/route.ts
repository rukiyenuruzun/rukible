import { COOKIE_NAME, tokenFor, safeEqual } from "@/lib/auth";

/** Şifreyi doğrular ve giriş çerezini bırakır. */
export async function POST(req: Request) {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    return new Response("APP_PASSWORD tanımlı değil.", { status: 503 });
  }

  const body = await req.json().catch(() => null);
  const attempt = typeof body?.password === "string" ? body.password : "";

  // Gönderilen şifreyi de özetleyip karşılaştırıyoruz ki karşılaştırma
  // her durumda aynı uzunlukta olsun.
  const expected = await tokenFor(password);
  const given = await tokenFor(attempt);

  if (!safeEqual(given, expected)) {
    // Kaba kuvvet denemelerini yavaşlatmak için küçük bir gecikme.
    await new Promise((r) => setTimeout(r, 600));
    return new Response("Şifre yanlış.", { status: 401 });
  }

  const response = Response.json({ ok: true });
  response.headers.append(
    "Set-Cookie",
    [
      `${COOKIE_NAME}=${expected}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${60 * 60 * 24 * 30}`, // 30 gün
      process.env.NODE_ENV === "production" ? "Secure" : "",
    ]
      .filter(Boolean)
      .join("; "),
  );
  return response;
}

/** Çıkış — çerezi siler. */
export async function DELETE() {
  const response = Response.json({ ok: true });
  response.headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
  return response;
}
