import Link from "next/link";
import { Logo, SLOGAN } from "../logo";

/**
 * Giriş sonrası seçim ekranı: iki yol.
 *   - Yeni oluştur       -> boş sayfadan tasarım üreteci (/)
 *   - Repo üstünden düzenle -> git reposu klonlayıp üstünde çalış (/repo)
 */
export default function Basla() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#fff7f3] px-6 text-stone-700">
      <div className="w-full max-w-[720px]">
        <div className="mb-9 flex flex-col items-center text-center">
          <Logo size={104} />
          <div className="mt-3 text-2xl font-semibold tracking-tight text-stone-800">
            Rukible
          </div>
          <div className="mt-1 text-[12px] text-orange-400">{SLOGAN}</div>
          <p className="mt-3 text-[13px] text-stone-500">Ne yapmak istersin?</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Link
            href="/"
            className="group rounded-2xl bg-white p-6 shadow-[0_1px_3px_rgba(120,80,60,0.08)] transition hover:shadow-[0_4px_16px_rgba(120,80,60,0.12)]"
          >
            <div className="text-3xl">✨</div>
            <div className="mt-3 text-[16px] font-semibold text-stone-800">
              Yeni oluştur
            </div>
            <p className="mt-1.5 text-[13px] leading-relaxed text-stone-500">
              Boş sayfadan, sohbetle sıfırdan bir tasarım üret. Sürümler, paylaşım
              linki, indirme — hepsi burada.
            </p>
            <div className="mt-4 text-[13px] font-medium text-orange-500 transition group-hover:translate-x-0.5">
              Başla →
            </div>
          </Link>

          <Link
            href="/repo"
            className="group rounded-2xl bg-white p-6 shadow-[0_1px_3px_rgba(120,80,60,0.08)] transition hover:shadow-[0_4px_16px_rgba(120,80,60,0.12)]"
          >
            <div className="text-3xl">🗂</div>
            <div className="mt-3 text-[16px] font-semibold text-stone-800">
              Repo üstünden düzenle
            </div>
            <p className="mt-1.5 text-[13px] leading-relaxed text-stone-500">
              Var olan bir git reposunu ver; Rukible klonlayıp dosyalarını sohbetle
              düzenlesin, arayüzü sağda göstersin.
            </p>
            <div className="mt-4 text-[13px] font-medium text-orange-500 transition group-hover:translate-x-0.5">
              Başla →
            </div>
          </Link>
        </div>
      </div>
    </main>
  );
}
