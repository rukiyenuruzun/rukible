import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase erişimi — SADECE sunucu tarafında.
 *
 * service_role anahtarı tam yetkilidir ve RLS'i baypas eder; tarayıcıya asla
 * gönderilmemeli. Bu yüzden bu dosya yalnızca API rotalarından import edilir.
 */

export const SUPABASE_URL =
  process.env.SUPABASE_URL ?? "https://wbgaumyggausjwyluecq.supabase.co";

let cached: SupabaseClient | null = null;

/** Yapılandırma eksikse null döner — çağıran taraf buna göre davranır. */
export function getDb(): SupabaseClient | null {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) return null;
  if (!cached) {
    cached = createClient(SUPABASE_URL, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}

export type Project = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export type Version = {
  id: string;
  project_id: string;
  html: string;
  prompt: string | null;
  cost: number | null;
  share_slug: string | null;
  created_at: string;
};

/** Paylaşım linki için tahmin edilemez, kısa kod üretir. */
export function makeSlug(length = 10): string {
  // Karışabilecek karakterler (0/O, 1/l/I) bilerek dışarıda bırakıldı.
  const alphabet = "23456789abcdefghijkmnpqrstuvwxyz";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
