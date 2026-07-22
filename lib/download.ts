/** Bir metni dosya olarak indirir (kopyala/indir için ortak yardımcı). */
export function downloadText(
  filename: string,
  text: string,
  mime = "text/plain",
): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
