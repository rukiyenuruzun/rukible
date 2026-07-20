import { readFileSync } from "node:fs";
import { applyPatches } from "../lib/patch.ts";

const original = readFileSync("/tmp/gen1.html", "utf8");
const patch = readFileSync("/tmp/edit1.patch", "utf8");

const result = applyPatches(original, patch);

console.log("mod:", result.mode);
console.log("uygulanan:", result.applied, "| başarısız:", result.failed);
console.log("notlar:", result.notes);
console.log();
console.log("eski başlık sayfada kaldı mı :", result.html.includes("Sipariş öncesi kontrol listesi"));
console.log("yeni başlık geldi mi         :", result.html.includes("Üretim öncesi doğrulama"));
console.log();
console.log("boyut önce/sonra:", original.length, "→", result.html.length);
console.log("sayfa bütünlüğü :", result.html.trimEnd().endsWith("</html>") ? "sağlam" : "BOZUK");

// Değişen bölge dışında hiçbir şey bozulmamalı.
const diffChars = Math.abs(original.length - result.html.length);
console.log("değişen karakter farkı:", diffChars, "(sadece başlık değişti, küçük olmalı)");
