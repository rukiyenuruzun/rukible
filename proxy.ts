import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { COOKIE_NAME, tokenFor, safeEqual } from "@/lib/auth";

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

  if (!password) {
    return new NextResponse(
      "APP_PASSWORD tanımlı değil. Araç güvenlik gereği kapalı. " +
        ".env.local dosyasına (ve Vercel'de ortam değişkenlerine) bir şifre ekle.",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  const cookie = request.cookies.get(COOKIE_NAME)?.value;
  if (cookie && safeEqual(cookie, await tokenFor(password))) {
    return NextResponse.next();
  }

  const url = new URL("/giris", request.url);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    // Paylaşım sayfaları, giriş ekranı ve statik dosyalar hariç her şey.
    "/((?!p/|giris|api/giris|_next/|favicon|icon).*)",
  ],
};
