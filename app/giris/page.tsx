import { Logo, SLOGAN } from "../logo";

/**
 * Giriş ekranı — sade.
 *
 * Bilerek bir sunucu bileşeni ve DÜZ HTML formu: JavaScript yüklenmese bile giriş
 * çalışmak zorunda. O yüzden <form method="POST" action="/api/giris"> aynen kalıyor.
 */
const CSS = `
@keyframes giris-bob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-10px)} }
.giris-logo{animation:giris-bob 3.6s ease-in-out infinite;will-change:transform}
@media (prefers-reduced-motion: reduce){ .giris-logo{animation:none} }
`;

export default async function Giris({
  searchParams,
}: {
  searchParams: Promise<{ hata?: string }>;
}) {
  const { hata } = await searchParams;

  const mesaj =
    hata === "sifre"
      ? "Şifre yanlış."
      : hata === "kurulum"
        ? "Sunucu kurulumu eksik: APP_PASSWORD ve SESSION_SECRET tanımlı olmalı."
        : "";

  return (
    <main className="grid min-h-screen place-items-center bg-[#fff7f3] px-6">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <form
        method="POST"
        action="/api/giris"
        className="flex w-full max-w-[300px] flex-col items-center"
      >
        <div className="giris-logo">
          <Logo size={210} />
        </div>
        <div className="mt-4 text-3xl font-semibold tracking-tight text-stone-800">
          Rukible
        </div>
        <div className="mt-1 text-[12px] text-orange-400">{SLOGAN}</div>

        <input
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Şifre"
          autoFocus
          className="mt-9 w-full rounded-2xl bg-white/80 px-4 py-3 text-[13px] text-stone-700 outline-none placeholder:text-stone-300 focus:bg-white"
        />

        <button
          type="submit"
          className="mt-2 w-full rounded-2xl bg-orange-400 py-2.5 text-[13px] font-medium text-white transition hover:bg-orange-500"
        >
          Gir
        </button>

        {mesaj && (
          <p className="mt-3 text-center text-[12px] text-rose-600">{mesaj}</p>
        )}
      </form>
    </main>
  );
}
