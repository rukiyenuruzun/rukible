/**
 * Rukible logosu — kodlayan maymun karakteri (public/rukible-logo.png).
 * Tarayıcı sekmesindeki ikon (favicon) AYRI: app/icon.svg + app/favicon.ico
 * (turuncu </> kutusu). Logoyu değiştirmek istersen public/rukible-logo.png'i
 * değiştir; sekme ikonu için icon.svg + favicon.ico'yu değiştir.
 */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/rukible-logo.png"
      alt="Rukible"
      style={{ height: size, width: "auto" }}
      className="shrink-0"
    />
  );
}

/** Slogan — değiştirmek istersen tek yer burası. */
export const SLOGAN = "possible with ruki.";
