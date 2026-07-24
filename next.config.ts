import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Next 16 dev sunucusu, localhost DIŞINDAKİ origin'lerden gelen dev
   * isteklerini (HMR websocket dahil) varsayılan olarak engelliyor. Engellenen
   * websocket yüzünden sayfa IP üzerinden açıldığında hydration hiç tamamlanmıyor
   * ve hiçbir düğme çalışmıyordu — konsolda hata da yok. Ağdaki başka bir
   * makineden (http://10.1.12.x:3000) erişim için origin'e izin ver.
   * Sadece dev modunu etkiler; production'da hükmü yok.
   */
  allowedDevOrigins: ["10.1.12.*"],
};

export default nextConfig;
