"use client";

import { useState } from "react";
import { Logo, SLOGAN } from "../logo";

export default function Giris() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError("");

    const res = await fetch("/api/giris", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (res.ok) {
      window.location.href = "/";
    } else {
      setError(await res.text());
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <main className="grid h-screen place-items-center bg-[#fff7f3] px-6">
      <form onSubmit={submit} className="w-full max-w-[280px]">
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
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Şifre"
          autoFocus
          className="w-full rounded-2xl bg-white/80 px-4 py-3 text-[13px] text-stone-700 outline-none placeholder:text-stone-300 focus:bg-white"
        />

        <button
          type="submit"
          disabled={busy || !password}
          className="mt-2 w-full rounded-2xl bg-orange-400 py-2.5 text-[13px] font-medium text-white transition hover:bg-orange-500 disabled:bg-stone-100 disabled:text-stone-300"
        >
          {busy ? "Kontrol ediliyor…" : "Gir"}
        </button>

        {error && (
          <p className="mt-3 text-center text-[12px] text-rose-600">{error}</p>
        )}
      </form>
    </main>
  );
}
