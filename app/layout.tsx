import type { Metadata } from "next";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const interTight = Inter_Tight({
  variable: "--font-sans",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Rukible — It's ruki-ble.",
  description: "Teknik ürün sayfaları için tasarım stüdyosu",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="tr"
      data-theme="light"
      suppressHydrationWarning
      className={`${interTight.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <head>
        {/* Boyamadan ÖNCE temayı ayarla (FOUC yok): önce kayıtlı tercih,
            yoksa sistem tercihi. Bkz. app/ThemeToggle.tsx (kayıt eden yer). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("rukible_theme");if(!t)t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col font-[family-name:var(--font-sans)]">
        {children}
      </body>
    </html>
  );
}
