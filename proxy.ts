import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { COOKIE_NAME, verifySession } from "@/lib/auth";

/**
 * Şifre kapısı. Aracın tamamını korur.
 *
 * Kasıtlı olarak KORUNMAYAN tek yer: /p/<kod> paylaşım sayfaları.
 * Onlar zaten dışarıya link olarak gönderilmek için var.
 *
 * Güvenli tarafta hata veriyoruz: APP_PASSWORD tanımlı değilse araç açılmaz.
 * Böylece şifre koymayı unutup interneti açık bırakma ihtimali kalmıyor.
 */
export async function proxy(request: NextRequest) {
  const password = process.env.APP_PASSWORD;
  const secret = process.env.SESSION_SECRET;

  if (!password || !secret) {
    const eksik = !password ? "APP_PASSWORD" : "SESSION_SECRET";
    return new NextResponse(
      `${eksik} tanımlı değil. Araç güvenlik gereği kapalı. ` +
        ".env.local dosyasına (ve Vercel'de ortam değişkenlerine) ekle. " +
        "SESSION_SECRET için rastgele uzun bir değer üret: openssl rand -hex 32",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  if (await verifySession(request.cookies.get(COOKIE_NAME)?.value, secret)) {
    return NextResponse.next();
  }

  const url = new URL("/giris", request.url);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    // Paylaşım sayfaları, giriş ekranı ve statik dosyalar (logo/ikon dahil)
    // hariç her şey. Logo giriş ekranında da görünmeli, o yüzden şifresiz.
    "/((?!p/|giris|api/giris|_next/|favicon|icon|rukible-logo).*)",
  ],
};
