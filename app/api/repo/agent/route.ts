import OpenAI from "openai";
import {
  AGENT_MODEL,
  MAX_AGENT_TOKENS,
  OPENROUTER_BASE_URL,
  REPO_LIMITS,
  REPO_MODE_ENABLED,
} from "@/lib/config";
import { line } from "@/lib/ndjson";
import { AGENT_SYSTEM_PROMPT, AGENT_PLAN_PROMPT } from "@/lib/agentPrompt";
import { REPO_TOOLS, REPO_TOOLS_READONLY, runTool, toolLabel } from "@/lib/repoTools";
import { isValidProjectId, workdirExists } from "@/lib/workspace";
import { withRepoLock } from "@/lib/repoLock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type ChatMessage = { role: "user" | "assistant"; content: string };
type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * POST /api/repo/agent
 * Gövde: { projectId, messages }
 * Yanıt: NDJSON akışı — {m:"agent"}, {t}, {w}, {a}, {n}, {u}
 *
 * Araçlı döngü: model dosya araçlarını çağırır, biz çalışma klasöründe
 * çalıştırıp sonucu geri besleriz; model araç istemeyi bırakınca biter.
 */
export async function POST(req: Request) {
  if (!REPO_MODE_ENABLED) {
    return new Response("Repo modu bu ortamda kapalı.", { status: 503 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return new Response("OPENROUTER_API_KEY tanımlı değil.", { status: 500 });
  }

  let body: {
    projectId?: string;
    messages?: ChatMessage[];
    mode?: string;
    style?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response("Geçersiz istek gövdesi.", { status: 400 });
  }

  const projectId = body.projectId ?? "";
  const messages = body.messages ?? [];
  const isPlan = body.mode === "plan";
  const tools = isPlan ? REPO_TOOLS_READONLY : REPO_TOOLS;

  // Görsel değişikliklerde uyulacak tasarım tercihi (yalnız build modunda).
  const STYLE_NOTES: Record<string, string> = {
    canli:
      "CANLI bir dil kullan: canlı renkler, yumuşak gradyanlar, belirgin ama zarif animasyonlar/geçişler.",
    minimal:
      "MİNİMAL kal: bol boşluk, az renk, sade tipografi; gereksiz süs ve efekt yok.",
    serbest: "Kullanıcının tarifine göre serbest davran; katı stil kuralı yok.",
    ruki:
      "Eğlenceli/şapşal bir dil kullan: renkli zeminler, bol emoji, oynak animasyonlar.",
    ai:
      "AI/derin teknoloji dili. KOYU zemin ama SAF SİYAH YASAK: derin LACİVERT/MOR " +
      "eksende kal, derinliği katmanlı koyu tonlarla kur. TEK vurgu gradyanı seç " +
      "(varsayılan mor→lacivert) ve sayfanın tamamında ona sadık kal. " +
      "BÖLÜMLER ARASI KESKİN ÇİZGİ OLMASIN: bölüm zeminleri gradyanla birbirine " +
      "aksın, arkada büyük blur'lu renk küreleri kullan — kesik kesik değil, akan " +
      "tek parça bir sayfa. Gradyanlı ana başlık, yarı saydam cam paneller " +
      "(blur + ince açık kenarlık), maskeli ince grid, ölçülü glow, küçük " +
      "etiketlerde mono font. HAREKET bol ama şık: scroll-behavior:smooth, " +
      "görünüre girdikçe yumuşak fade+kayma, hafif parallax, 200-300ms ease-out " +
      "hover. Sürekli zıplayan öğe yok. Okunurluk her şeyden önce.",
    muhendis: "",
  };
  const styleNote = STYLE_NOTES[String(body.style ?? "")] ?? "";
  const systemPrompt =
    (isPlan ? AGENT_PLAN_PROMPT : AGENT_SYSTEM_PROMPT) +
    (styleNote && !isPlan ? `\n\nTASARIM TERCİHİ (görsel değişikliklerde): ${styleNote}` : "");
  if (!isValidProjectId(projectId)) {
    return new Response("Geçersiz proje kimliği.", { status: 400 });
  }
  if (!(await workdirExists(projectId))) {
    return new Response("Proje klasörü bulunamadı. Önce klonla.", { status: 404 });
  }
  if (messages.length === 0) {
    return new Response("Mesaj yok.", { status: 400 });
  }

  const client = new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL });

  const conversation: Msg[] = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content }) as Msg),
  ];

  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 };

  const readable = new ReadableStream({
    async start(controller) {
      controller.enqueue(line({ m: "agent" }));

      // Aynı projeye eşzamanlı yazımları serileştir (klon/agent yarışı olmasın).
      try {
        await withRepoLock(projectId, async () => {
          let toolCalls = 0;
          /** Kaç dosya yazıldı — hiç yazılmadıysa "tamamlandı" demek yanıltıcı olur. */
          let yazilanDosya = 0;
          /** "Anlatıp durma, araçları kullan" dürtmesi kaç kez yapıldı. */
          let durtme = 0;
          const MAX_DURTME = 2;

          for (let turn = 0; turn < REPO_LIMITS.maxTurns; turn++) {
            const params = {
              model: AGENT_MODEL,
              max_tokens: MAX_AGENT_TOKENS,
              tools,
              tool_choice: "auto",
              messages: conversation,
              usage: { include: true },
            } as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming;

            const resp = await client.chat.completions.create(params);

            const u = resp.usage as
              | (OpenAI.CompletionUsage & { cost?: number })
              | undefined;
            if (u) {
              usage.prompt_tokens += u.prompt_tokens ?? 0;
              usage.completion_tokens += u.completion_tokens ?? 0;
              usage.total_tokens += u.total_tokens ?? 0;
              usage.cost += u.cost ?? 0;
            }

            const msg = resp.choices?.[0]?.message;
            if (!msg) {
              controller.enqueue(line({ n: "Model boş yanıt döndü." }));
              break;
            }

            if (msg.content) controller.enqueue(line({ a: msg.content }));
            conversation.push(msg as Msg);

            const calls = msg.tool_calls ?? [];
            if (calls.length === 0) {
              // Model sık sık "şimdi şunu yapıyorum" deyip araç çağırmadan
              // duruyor. Build modunda henüz hiçbir şey yazılmadıysa bunu
              // "iş bitti" saymak yanlış: bir kez dürtüp devam ettir.
              if (!isPlan && yazilanDosya === 0 && durtme < MAX_DURTME) {
                durtme++;
                conversation.push({
                  role: "user",
                  content:
                    "Anlatma, YAP. Araçları kullan: önce list_files/read_file ile " +
                    "ilgili dosyaları incele, sonra write_file ile değişiklikleri " +
                    "yaz. Bu turda en az bir write_file çağırmalısın.",
                });
                continue;
              }
              break; // model işini bitirdi
            }

            for (const call of calls) {
              if (call.type !== "function") continue;
              if (toolCalls >= REPO_LIMITS.maxToolCalls) {
                controller.enqueue(
                  line({ n: "Araç çağrısı sınırına ulaşıldı, durduruldu." }),
                );
                conversation.push({
                  role: "tool",
                  tool_call_id: call.id,
                  content: "HATA: araç sınırı aşıldı.",
                });
                continue;
              }
              toolCalls++;

              const fname = call.function.name;
              const fargs = call.function.arguments ?? "{}";
              controller.enqueue(line({ t: toolLabel(fname, fargs) }));

              const result = await runTool(projectId, fname, fargs);
              if (result.event) {
                if ("w" in result.event) yazilanDosya++;
                controller.enqueue(line(result.event));
              }

              conversation.push({
                role: "tool",
                tool_call_id: call.id,
                content: result.content,
              });
            }
          }

          // Build modunda hiç dosya yazılmadıysa bunu AÇIKÇA söyle: sessizce
          // bitmek "yapıldı" izlenimi veriyordu.
          if (!isPlan && yazilanDosya === 0) {
            controller.enqueue(
              line({
                n: "Model hiçbir dosyayı değiştirmedi. İsteği daha somut yaz (hangi dosya/bölüm, ne değişsin) ya da tekrar dene.",
              }),
            );
          }
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "bilinmeyen hata";
        controller.enqueue(line({ n: `Ajan hatası: ${message}` }));
      } finally {
        controller.enqueue(line({ u: usage }));
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
