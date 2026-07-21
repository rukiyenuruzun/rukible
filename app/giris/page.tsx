import { Logo, SLOGAN } from "../logo";

/**
 * Giriş ekranı — Ruki temalı.
 *
 * Bilerek bir sunucu bileşeni ve DÜZ HTML formu: JavaScript yüklenmese bile giriş
 * çalışmak zorunda. O yüzden tüm hareket saf CSS (@keyframes) ile; form aynen
 * <form method="POST" action="/api/giris"> olarak kalıyor.
 */

// Arka planda uçuşan maymunlar/muzlar — her biri farklı yer, boyut, gecikme.
const MONKEYS = [
  { e: "🐵", top: "8%", left: "9%", size: "3.6rem", d: "0s", dur: "6s" },
  { e: "🙈", top: "16%", left: "82%", size: "3rem", d: "1.2s", dur: "7s" },
  { e: "🍌", top: "72%", left: "12%", size: "2.6rem", d: "0.6s", dur: "5.5s" },
  { e: "🙉", top: "78%", left: "80%", size: "3.2rem", d: "2s", dur: "6.5s" },
  { e: "🐒", top: "45%", left: "5%", size: "2.8rem", d: "1.5s", dur: "8s" },
  { e: "🙊", top: "38%", left: "90%", size: "3rem", d: "0.9s", dur: "6s" },
  { e: "🎉", top: "88%", left: "46%", size: "2.4rem", d: "1.8s", dur: "5s" },
  { e: "🐵", top: "60%", left: "72%", size: "2.1rem", d: "2.4s", dur: "7s" },
  { e: "✨", top: "12%", left: "47%", size: "2rem", d: "0.3s", dur: "4.5s" },
  { e: "🍌", top: "30%", left: "24%", size: "2rem", d: "1.1s", dur: "6.5s" },
  { e: "🐒", top: "86%", left: "22%", size: "2.3rem", d: "0.4s", dur: "7.5s" },
  { e: "🙈", top: "55%", left: "40%", size: "1.8rem", d: "2.2s", dur: "5s" },
];

const CSS = `
@keyframes ruki-grad { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
@keyframes ruki-float { 0%,100%{transform:translateY(0) rotate(-6deg)} 50%{transform:translateY(-22px) rotate(6deg)} }
@keyframes ruki-bob { 0%,100%{transform:translateY(0) rotate(-2deg)} 50%{transform:translateY(-12px) rotate(2deg)} }
@keyframes ruki-pop { 0%,100%{transform:scale(1) rotate(0)} 25%{transform:scale(1.06) rotate(-3deg)} 75%{transform:scale(1.06) rotate(3deg)} }
@keyframes ruki-in { 0%{opacity:0;transform:translateY(16px) scale(.9)} 100%{opacity:1;transform:translateY(0) scale(1)} }
.ruki-bg{position:absolute;inset:0;background:linear-gradient(120deg,#fb923c,#f472b6,#c084fc,#38bdf8,#fde047,#fb923c);background-size:300% 300%;animation:ruki-grad 14s ease infinite}
.ruki-monkey{position:absolute;animation:ruki-float 6s ease-in-out infinite;filter:drop-shadow(0 6px 10px rgba(0,0,0,.14));will-change:transform}
.ruki-card{animation:ruki-in .5s ease-out both}
.ruki-logo{animation:ruki-bob 3.4s ease-in-out infinite;will-change:transform}
.ruki-gir{transition:transform .15s}
.ruki-gir:hover{animation:ruki-pop .5s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){ .ruki-bg,.ruki-monkey,.ruki-logo,.ruki-card,.ruki-gir:hover{animation:none} }
`;

export default async function Giris({
  searchParams,
}: {
  searchParams: Promise<{ hata?: string }>;
}) {
  const { hata } = await searchParams;

  const mesaj =
    hata === "sifre"
      ? "Şifre yanlış 🙈 bir daha dene."
      : hata === "kurulum"
        ? "Sunucuda APP_PASSWORD tanımlı değil."
        : "";

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-6">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      {/* Renkli hareketli zemin */}
      <div className="ruki-bg" aria-hidden="true" />

      {/* Uçuşan maymunlar */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        {MONKEYS.map((m, i) => (
          <span
            key={i}
            className="ruki-monkey"
            style={{
              top: m.top,
              left: m.left,
              fontSize: m.size,
              animationDelay: m.d,
              animationDuration: m.dur,
            }}
          >
            {m.e}
          </span>
        ))}
      </div>

      {/* Giriş kartı */}
      <form
        method="POST"
        action="/api/giris"
        className="ruki-card relative z-10 w-full max-w-[320px] rounded-[28px] border-4 border-white bg-white/85 p-7 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-sm"
      >
        <div className="flex flex-col items-center text-center">
          <div className="ruki-logo">
            <Logo size={128} />
          </div>
          <div className="mt-3 text-3xl font-extrabold tracking-tight text-stone-800">
            Rukible
          </div>
          <div className="mt-1 text-[12px] font-medium text-orange-500">{SLOGAN}</div>
        </div>

        <input
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Şifre 🍌"
          autoFocus
          className="mt-6 w-full rounded-2xl border-2 border-orange-200 bg-white px-4 py-3 text-[14px] text-stone-700 outline-none transition placeholder:text-stone-300 focus:border-orange-400"
        />

        <button
          type="submit"
          className="ruki-gir mt-3 w-full rounded-2xl bg-orange-400 py-3 text-[15px] font-bold text-white shadow-[0_8px_20px_rgba(251,146,60,0.45)] transition hover:bg-orange-500"
        >
          Gir 🚀
        </button>

        {mesaj && (
          <p className="mt-3 text-center text-[12.5px] font-medium text-rose-600">{mesaj}</p>
        )}
      </form>
    </main>
  );
}
