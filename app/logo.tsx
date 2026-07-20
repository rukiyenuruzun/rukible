/**
 * Geçici logo — yuvarlak köşeli bir kutu (muhafaza) + içinde kıvılcım.
 * Kendi tasarımın hazır olunca sadece bu dosyanın içindeki SVG'yi değiştir,
 * kullanıldığı yerlere dokunman gerekmez. Aynı çizim app/icon.svg'de de var
 * (tarayıcı sekmesindeki ikon) — onu da güncellemeyi unutma.
 */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="32" height="32" rx="10" fill="#fb923c" />
      <path
        d="M16 7.5c.6 5.2 3.3 7.9 8.5 8.5-5.2.6-7.9 3.3-8.5 8.5-.6-5.2-3.3-7.9-8.5-8.5 5.2-.6 7.9-3.3 8.5-8.5z"
        fill="#fff"
      />
    </svg>
  );
}

/** Slogan — değiştirmek istersen tek yer burası. */
export const SLOGAN = "possible with ruki.";
