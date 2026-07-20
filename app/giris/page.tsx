import { Logo, SLOGAN } from "../logo";

/**
 * Giriş ekranı.
 *
 * Bilerek bir sunucu bileşeni ve düz HTML formu: JavaScript yüklenmese veya
 * hata verse bile giriş çalışmak zorunda. Aksi halde kullanıcı dışarıda kalır.
 */
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
        ? "Sunucuda APP_PASSWORD tanımlı değil."
        : "";

  return (
    <main className="grid h-screen place-items-center bg-[#fff7f3] px-6">
      <form method="POST" action="/api/giris" className="w-full max-w-[280px]">
        <div className="mb-8 flex items-center gap-2.5">
          <Logo size={26} />
          <div className="leading-none">
            <div className="text-[19px] font-semibold tracking-tight text-stone-800">
              Rukible
            </div>
            <div className="mt-1 text-[11px] text-orange-400">{SLOGAN}</div>
          </div>
        </div>

        <input
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Şifre"
          autoFocus
          className="w-full rounded-2xl bg-white/80 px-4 py-3 text-[13px] text-stone-700 outline-none placeholder:text-stone-300 focus:bg-white"
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
