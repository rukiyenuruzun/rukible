import { fetchPageProfile, profileToPrompt } from "../lib/fetchPage.ts";

const url = process.argv[2];
if (!url) {
  console.error("Kullanım: node scripts/test-fetch.mts <url>");
  process.exit(1);
}

const profile = await fetchPageProfile(url);
const prompt = profileToPrompt(profile);

console.log(prompt.slice(0, 2500));
console.log("\n--- ÖZET ---");
console.log("Başarılı:", profile.ok, profile.error ?? "");
console.log("Başlık sayısı:", profile.headings?.length ?? 0);
console.log("Bulunan renk:", profile.colors?.length ?? 0);
console.log("Bulunan font:", profile.fonts?.length ?? 0);
console.log("Toplam karakter:", prompt.length, "≈", Math.round(prompt.length / 4), "token");
