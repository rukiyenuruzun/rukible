import { NextResponse } from "next/server";
import { COOKIE_NAME, tokenFor, safeEqual } from "@/lib/auth";

const COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: 60 * 60 * 24 * 30, // 30 gün
  secure: process.env.NODE_ENV === "production",
};

/**
 * Şifreyi doğrular ve giriş çerezini bırakır.
 *
 * İki biçimi de kabul eder:
 *  - Klasik form gönderimi (JavaScript gerekmez) -> yönlendirme ile cevap verir
 *  - JSON (fetch) -> JSON ile cevap verir
 *
 * Form yolu bilerek var: JavaScript yüklenmediğinde bile girişin çalışması
 * gerekiyor, aksi halde kullanıcı kilitli kalıyor.
 */
export async function POST(req: Request) {
  const password = process.env.APP_PASSWORD;
  const contentType = req.headers.get("content-type") ?? "";
  const isForm =
    contentType.includes("form-urlencoded") || contentType.includes("form-data");

  if (!password) {
    return isForm
      ? NextResponse.redirect(new URL("/giris?hata=kurulum", req.url), 303)
      : new Response("APP_PASSWORD tanımlı değil.", { status: 503 });
  }

  let attempt = "";
  if (isForm) {
    const form = await req.formData();
    attempt = String(form.get("password") ?? "");
  } else {
    const body = await req.json().catch(() => null);
    attempt = typeof body?.password === "string" ? body.password : "";
  }

  const expected = await tokenFor(password);
  const given = await tokenFor(attempt);

  if (!safeEqual(given, expected)) {
    // Kaba kuvvet denemelerini yavaşlatmak için küçük bir gecikme.
    await new Promise((r) => setTimeout(r, 600));
    return isForm
      ? NextResponse.redirect(new URL("/giris?hata=sifre", req.url), 303)
      : new Response("Şifre yanlış.", { status: 401 });
  }

  const response = isForm
    ? NextResponse.redirect(new URL("/basla", req.url), 303)
    : NextResponse.json({ ok: true });

  response.cookies.set(COOKIE_NAME, expected, COOKIE_OPTIONS);
  return response;
}

/** Çıkış — çerezi siler. */
export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE_NAME, "", { ...COOKIE_OPTIONS, maxAge: 0 });
  return response;
}
