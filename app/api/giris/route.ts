import { NextResponse } from "next/server";
import {
  COOKIE_NAME,
  SESSION_TTL_MS,
  issueSession,
  passwordMatches,
} from "@/lib/auth";

const COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  // Çerezin ömrü jetonun ömrüyle aynı: tarayıcı, sunucunun zaten kabul
  // etmeyeceği bir jetonu taşımasın.
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
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
  const secret = process.env.SESSION_SECRET;
  const contentType = req.headers.get("content-type") ?? "";
  const isForm =
    contentType.includes("form-urlencoded") || contentType.includes("form-data");

  if (!password || !secret) {
    return isForm
      ? NextResponse.redirect(new URL("/giris?hata=kurulum", req.url), 303)
      : new Response(
          `${!password ? "APP_PASSWORD" : "SESSION_SECRET"} tanımlı değil.`,
          { status: 503 },
        );
  }

  let attempt = "";
  if (isForm) {
    const form = await req.formData();
    attempt = String(form.get("password") ?? "");
  } else {
    const body = await req.json().catch(() => null);
    attempt = typeof body?.password === "string" ? body.password : "";
  }

  if (!(await passwordMatches(attempt, password))) {
    // Kaba kuvvet denemelerini yavaşlatmak için küçük bir gecikme.
    await new Promise((r) => setTimeout(r, 600));
    return isForm
      ? NextResponse.redirect(new URL("/giris?hata=sifre", req.url), 303)
      : new Response("Şifre yanlış.", { status: 401 });
  }

  const response = isForm
    ? NextResponse.redirect(new URL("/", req.url), 303)
    : NextResponse.json({ ok: true });

  // Çereze şifreden türetilen bir şey DEĞİL, süreli ve imzalı bir oturum
  // jetonu yazılır (bkz. lib/auth.ts).
  response.cookies.set(COOKIE_NAME, await issueSession(secret), COOKIE_OPTIONS);
  return response;
}

/** Çıkış — çerezi siler. */
export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE_NAME, "", { ...COOKIE_OPTIONS, maxAge: 0 });
  return response;
}
