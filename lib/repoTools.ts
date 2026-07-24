import type OpenAI from "openai";
import {
  listTree,
  readTextFile,
  writeBinaryFile,
  writeTextFile,
  WorkdirError,
} from "@/lib/workspace";

/**
 * Araçlı (agentic) döngünün dosya araçları. Hepsi çalışma klasörüne
 * (lib/workspace) hapsedilmiştir; model klasör dışına çıkamaz.
 */

export const REPO_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "Projedeki tüm dosyaların yollarını listeler. Düzenlemeye başlamadan " +
        "önce projenin yapısını görmek için kullan.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Bir dosyanın tam içeriğini okur. Değiştireceğin dosyayı yazmadan önce " +
        "MUTLAKA oku ki mevcut içeriği bilerek düzenleyesin.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Proje köküne göre dosya yolu" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Bir dosyanın TAM yeni içeriğini yazar (dosyanın tamamını değiştirir; " +
        "kısmi yama değil). Yoksa oluşturur. Önce read_file ile mevcut içeriği al, " +
        "gereken değişikliği yap, tüm dosyayı geri yaz.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Proje köküne göre dosya yolu" },
          content: { type: "string", description: "Dosyanın yeni tam içeriği" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description:
        "Tüm metin dosyalarında bir metni (büyük/küçük harf duyarsız) arar ve " +
        "eşleşen dosya:satır sonuçlarını döner. Bir metnin hangi dosyada olduğunu " +
        "bulmak için kullan.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Aranacak metin" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
];

/**
 * Kullanıcı mesajına görsel iliştirdiğinde (yalnız build modunda) araç
 * listesine eklenir; başka zaman model bu aracı hiç görmez (bkz. agent route).
 */
export const SAVE_IMAGE_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "save_image",
    description:
      "Kullanıcının bu mesaja iliştirdiği görseli projeye dosya olarak kaydeder " +
      "(örn. assets/logo.png). Kullanıcı görseli projeye/sayfaya eklemeni " +
      "istiyorsa önce bununla kaydet, sonra HTML/CSS'te bu yola referans ver.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Proje köküne göre hedef dosya yolu; uzantıyı görselin formatına " +
            "uygun seç (jpg/png/webp)",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

/** Plan modu: salt-okunur araçlar (write_file YOK) — sadece keşfedip planlar. */
export const REPO_TOOLS_READONLY: OpenAI.Chat.Completions.ChatCompletionTool[] =
  REPO_TOOLS.filter(
    (t) => !(t.type === "function" && t.function.name === "write_file"),
  );

const SEARCH_MAX_MATCHES = 40;
const TEXT_EXT =
  /\.(html?|css|js|mjs|cjs|jsx|ts|tsx|json|md|txt|xml|svg|vue|astro|scss|sass|less)$/i;

export type ToolResult = { content: string; event?: Record<string, string> };

/** Araç adı + argümanlardan kısa bir kullanıcı etiketi üretir. */
export function toolLabel(name: string, argsRaw: string): string {
  try {
    const a = JSON.parse(argsRaw || "{}");
    if (name === "read_file" && a.path) return `okuyor: ${a.path}`;
    if (name === "write_file" && a.path) return `yazıyor: ${a.path}`;
    if (name === "save_image" && a.path) return `görseli kaydediyor: ${a.path}`;
    if (name === "search" && a.query) return `arıyor: "${a.query}"`;
    if (name === "list_files") return "dosyaları listeliyor";
  } catch {
    // yoksay
  }
  return name;
}

export async function runTool(
  projectId: string,
  name: string,
  argsRaw: string,
  ctx: { image?: string } = {},
): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsRaw || "{}");
  } catch {
    return { content: "HATA: araç argümanları geçersiz JSON." };
  }

  try {
    switch (name) {
      case "list_files": {
        const tree = await listTree(projectId);
        const files = tree.filter((e) => e.type === "file").map((e) => e.path);
        return { content: files.join("\n") || "(boş proje)" };
      }
      case "read_file": {
        const p = String(args.path ?? "");
        if (!p) return { content: "HATA: path gerekli." };
        const text = await readTextFile(projectId, p);
        return { content: text };
      }
      case "write_file": {
        const p = String(args.path ?? "");
        const content = typeof args.content === "string" ? args.content : "";
        if (!p) return { content: "HATA: path gerekli." };
        await writeTextFile(projectId, p, content);
        return {
          content: `OK: ${p} yazıldı (${Buffer.byteLength(content)} bayt).`,
          event: { w: `${p} yazıldı` },
        };
      }
      case "save_image": {
        const p = String(args.path ?? "");
        if (!p) return { content: "HATA: path gerekli." };
        if (!ctx.image) {
          return { content: "HATA: bu mesaja iliştirilmiş bir görsel yok." };
        }
        // data:image/png;base64,... -> ham baytlar
        const comma = ctx.image.indexOf(",");
        const buf = Buffer.from(comma >= 0 ? ctx.image.slice(comma + 1) : "", "base64");
        if (buf.byteLength === 0) return { content: "HATA: görsel verisi çözülemedi." };
        await writeBinaryFile(projectId, p, buf);
        return {
          content: `OK: görsel ${p} olarak kaydedildi (${buf.byteLength} bayt).`,
          event: { w: `${p} kaydedildi` },
        };
      }
      case "search": {
        const q = String(args.query ?? "").toLowerCase();
        if (!q) return { content: "HATA: query gerekli." };
        const tree = await listTree(projectId);
        const matches: string[] = [];
        for (const e of tree) {
          if (e.type !== "file" || !TEXT_EXT.test(e.path)) continue;
          if (matches.length >= SEARCH_MAX_MATCHES) break;
          let text: string;
          try {
            text = await readTextFile(projectId, e.path);
          } catch {
            continue;
          }
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(q)) {
              matches.push(`${e.path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
              if (matches.length >= SEARCH_MAX_MATCHES) break;
            }
          }
        }
        return {
          content: matches.length ? matches.join("\n") : "(eşleşme yok)",
        };
      }
      default:
        return { content: `HATA: bilinmeyen araç "${name}".` };
    }
  } catch (err) {
    if (err instanceof WorkdirError) return { content: `HATA: ${err.message}` };
    const msg = err instanceof Error ? err.message : "bilinmeyen hata";
    return { content: `HATA: ${msg}` };
  }
}
