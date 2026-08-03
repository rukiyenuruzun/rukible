"use client";

import { useState } from "react";

/**
 * Açık/koyu tema düğmesi. Temayı <html data-theme> üzerinde çevirir ve
 * localStorage("rukible_theme") içine yazar; ilk boyamadan önceki ayarı
 * app/layout.tsx head script'i yapar (FOUC yok). Burada sadece kullanıcı
 * elle değiştirdiğinde güncelleriz.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  // Sunucuda tema bilinmez → "light" varsay. İstemcide ilk render'da DOM'daki
  // gerçek değeri okuruz (head script'i çoktan ayarladı). Olası SSR/istemci
  // ikon farkı aşağıdaki suppressHydrationWarning ile bastırılır.
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "dark"
      ? "dark"
      : "light",
  );

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("rukible_theme", next);
    } catch {
      /* localStorage kapalıysa yut — tema yine de bu oturumda değişir. */
    }
    setTheme(next);
  }

  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      title={dark ? "Açık temaya geç" : "Koyu temaya geç"}
      aria-label="Temayı değiştir"
      className={
        className ||
        "grid h-8 w-8 place-items-center rounded-full bg-white text-[15px] shadow-[0_1px_3px_rgba(120,80,60,0.12)] transition hover:bg-orange-50"
      }
    >
      {/* Mount öncesi ikon ile hidrasyon uyuşmazlığı olmasın diye bastırıyoruz. */}
      <span suppressHydrationWarning>{dark ? "☀️" : "🌙"}</span>
    </button>
  );
}
