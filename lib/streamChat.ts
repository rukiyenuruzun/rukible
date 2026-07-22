/**
 * NDJSON akış okuyucu (istemci).
 *
 * Bir fetch Response gövdesini satır satır okur, her satırı JSON.parse edip
 * `on` geri çağrısına verir. Hem sayfa üreteci hem repo modu aynı çerçeveyi
 * kullandığı için tek okuma döngüsü yeterli.
 */
export type NdjsonMsg = {
  m?: string;
  c?: string;
  r?: string;
  n?: string;
  a?: string;
  t?: string;
  w?: string;
  u?: { cost?: number; total_tokens?: number };
};

export async function readNdjson(
  res: Response,
  on: (msg: NdjsonMsg) => void,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      if (!raw.trim()) continue;
      try {
        on(JSON.parse(raw));
      } catch {
        // yarım/bozuk satır — atla
      }
    }
  }
  if (buffer.trim()) {
    try {
      on(JSON.parse(buffer));
    } catch {
      // yoksay
    }
  }
}
