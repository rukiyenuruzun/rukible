import { applyPatches } from "../lib/patch.ts";

const original = `<!DOCTYPE html>
<html><body>
  <a href="#teklif" class="btn-primary px-6 py-3">Teklif alın</a>
  <p class="text-sm">Merhaba</p>
</body></html>`;

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

console.log("1) Normal yama");
const r1 = applyPatches(
  original,
  `<<<<<<< SEARCH
  <a href="#teklif" class="btn-primary px-6 py-3">Teklif alın</a>
=======
  <a href="#teklif" class="bg-[#101828] text-white px-6 py-3">Teklif alın</a>
>>>>>>> REPLACE`,
);
check("uygulandı", r1.applied === 1 && r1.failed === 0);
check("yeni sınıf var", r1.html.includes("bg-[#101828]"));
check("eski sınıf gitti", !r1.html.includes("btn-primary"));
check("sayfanın gerisi bozulmadı", r1.html.includes("Merhaba"));

console.log("2) Birden fazla yama");
const r2 = applyPatches(
  original,
  `<<<<<<< SEARCH
<p class="text-sm">Merhaba</p>
=======
<p class="text-sm">Selam</p>
>>>>>>> REPLACE
<<<<<<< SEARCH
Teklif alın
=======
Fiyat isteyin
>>>>>>> REPLACE`,
);
check("ikisi de uygulandı", r2.applied === 2, `applied=${r2.applied}`);

console.log("3) Eşleşmeyen yama");
const r3 = applyPatches(
  original,
  `<<<<<<< SEARCH
bu metin sayfada yok
=======
yeni
>>>>>>> REPLACE`,
);
check("hata sayıldı", r3.failed === 1 && r3.applied === 0);
check("sayfa bozulmadı", r3.html === original);

console.log("4) Model kurala uymayıp tam sayfa dönerse");
const r4 = applyPatches(original, `<!DOCTYPE html>\n<html><body>Yeni</body></html>`);
check("tam sayfa modu", r4.mode === "full");

console.log("5) Boş / anlamsız çıktı");
const r5 = applyPatches(original, "Tamamdır, değişikliği yaptım.");
check("sayfa korundu", r5.mode === "none" && r5.html === original);

console.log(`\n${pass} geçti, ${fail} kaldı`);
process.exit(fail === 0 ? 0 : 1);
