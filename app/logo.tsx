import Link from "next/link";

/**
 * Rukible logosu — kodlayan maymun karakteri (public/rukible-logo.png).
 * Tarayıcı sekmesindeki ikon (favicon) AYRI: app/icon.svg + app/favicon.ico
 * (turuncu </> kutusu). Logoyu değiştirmek istersen public/rukible-logo.png'i
 * değiştir; sekme ikonu için icon.svg + favicon.ico'yu değiştir.
 *
 * `href` verilirse logo tıklanabilir olur (genelde "/" = ana sayfa): üzerine
 * gelince hafif tepki + tooltip. Verilmezse düz görsel kalır.
 */
export function Logo({ size = 22, href }: { size?: number; href?: string }) {
  const img = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/rukible-logo.png"
      alt="Rukible"
      style={{ height: size, width: "auto" }}
      className="shrink-0"
    />
  );
  if (!href) return img;
  return (
    <Link
      href={href}
      title="Ana sayfa"
      aria-label="Ana sayfaya git"
      className="inline-flex shrink-0 rounded-2xl transition hover:opacity-80 active:scale-95"
    >
      {img}
    </Link>
  );
}

/** Slogan — değiştirmek istersen tek yer burası. */
export const SLOGAN = "possible with ruki.";
