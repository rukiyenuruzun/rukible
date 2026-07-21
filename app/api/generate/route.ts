import OpenAI from "openai";
import {
  MODEL,
  MAX_OUTPUT_TOKENS,
  MAX_EDIT_TOKENS,
  MAX_PLAN_TOKENS,
  OPENROUTER_BASE_URL,
  REASONING_EFFORT_HARD,
} from "@/lib/config";
import {
  SYSTEM_PROMPT,
  EDIT_SYSTEM_PROMPT,
  PLAN_SYSTEM_PROMPT,
  FULL_EDIT_SYSTEM_PROMPT,
} from "@/lib/prompt";
import { chooseEffort } from "@/lib/intent";
import { extractUrls, fetchPageProfile, profileToPrompt } from "@/lib/fetchPage";

// Uzun üretimler için gerekli (Vercel'de varsayılan limit çok kısa).
export const maxDuration = 300;

/** Tek istekte taranacak en fazla sayfa sayısı (maliyet sınırı). */
const MAX_URLS_PER_REQUEST = 2;

type ChatMessage = { role: "user" | "assistant"; content: string };

/**
 * Akış NDJSON formatında: her satır bir JSON nesnesi.
 *   {"c": "..."} -> sayfa HTML'i (içerik)
 *   {"r": "..."} -> modelin düşünme metni (HTML'e KARIŞMAMALI)
 *   {"n": "..."} -> kullanıcıya gösterilecek durum notu
 *   {"u": {...}} -> bitişte token ve maliyet bilgisi
 */
function line(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}

export async function POST(req: Request) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    return new Response(
      "OPENROUTER_API_KEY tanımlı değil. .env.local dosyasına ekleyip sunucuyu yeniden başlat.",
      { status: 500 },
    );
  }

  let body: { messages?: ChatMessage[]; currentHtml?: string; mode?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Geçersiz istek gövdesi.", { status: 400 });
  }

  const { messages = [], currentHtml, mode } = body;
  if (messages.length === 0) {
    return new Response("Mesaj bulunamadı.", { status: 400 });
  }

  const client = new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL });

  // Plan modu: model kod üretmez, sadece ne yapılacağını planlar.
  const isPlan = mode === "plan";
  // Tam yeniden yazım: yama tutmadığında yedek — model tüm sayfayı değişiklikle
  // yeniden yazar (pahalı ama güvenilir).
  const isFullEdit = mode === "fulledit";
  // Ortada bir sayfa varsa düzenleme modundayız: model tüm sayfayı değil,
  // sadece değişecek blokları döndürür. Maliyetin büyük kısmı burada düşüyor.
  const isEdit = !isPlan && !isFullEdit && Boolean(currentHtml);

  const systemPrompt = isPlan
    ? PLAN_SYSTEM_PROMPT
    : isFullEdit
      ? FULL_EDIT_SYSTEM_PROMPT
      : isEdit
        ? EDIT_SYSTEM_PROMPT
        : SYSTEM_PROMPT;

  const conversation: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemPrompt },
  ];

  // Son mesajda link varsa sayfayı sunucu tarafında çekip modele veriyoruz.
  // Böylece model içeriği tahmin etmek yerine gerçek sayfaya bakar.
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const urls = lastUserMessage
    ? extractUrls(lastUserMessage.content).slice(0, MAX_URLS_PER_REQUEST)
    : [];

  const notes: string[] = [];

  if (urls.length > 0) {
    const profiles = await Promise.all(urls.map(fetchPageProfile));
    for (const p of profiles) {
      notes.push(p.ok ? `${p.url} tarandı` : `${p.url} alınamadı — ${p.error}`);
    }
    conversation.push({
      role: "user",
      content:
        "Aşağıda kullanıcının paylaştığı sayfa(lar)dan çıkarılan gerçek veri var. " +
        "Bu veriye dayan, sayfa hakkında tahmin yürütme.\n\n" +
        profiles.map(profileToPrompt).join("\n\n---\n\n"),
    });
    conversation.push({ role: "assistant", content: "Referans sayfayı inceledim." });
  }

  if (currentHtml) {
    if (isPlan) {
      conversation.push({
        role: "user",
        content:
          "Üzerinde konuşacağımız mevcut sayfanın tamamı aşağıdadır. Buna bakarak " +
          `planla; kodu DEĞİŞTİRME, sadece ne yapılacağını anlat:\n\n${currentHtml}`,
      });
      conversation.push({
        role: "assistant",
        content: "Sayfayı inceledim. Ne yapmak istediğini söyle, planlayalım.",
      });
    } else if (isFullEdit) {
      conversation.push({
        role: "user",
        content:
          "Aşağıdaki sayfaya istenen değişikliği uygula ve sayfanın TAMAMINI döndür. " +
          `Değişiklik dışındaki her şeyi birebir koru:\n\n${currentHtml}`,
      });
      conversation.push({
        role: "assistant",
        content: "Tamam. Değişikliği uygulayıp sayfanın tamamını döndüreceğim.",
      });
    } else {
      conversation.push({
        role: "user",
        content:
          "Düzenlenecek sayfanın tamamı aşağıdadır. SEARCH bloklarını buradan " +
          `birebir kopyala:\n\n${currentHtml}`,
      });
      conversation.push({
        role: "assistant",
        content: "Sayfayı aldım. Değişiklik isteğini SEARCH/REPLACE olarak döneceğim.",
      });
    }
  }

  conversation.push(...messages);

  // Belirsiz/çok parçalı isteklerde model daha çok düşünsün; net isteklerde
  // taban seviyede kalıp ucuz çalışsın. (bkz. lib/intent.ts)
  // Plan ve tam yeniden yazım daha ağır işler; düşük seviyede model tembelleşip
  // değişikliği hiç yapmayabiliyor — bu ikisinde taban en az "medium".
  const baseEffort = chooseEffort(lastUserMessage?.content ?? "");
  const effort =
    (isPlan || isFullEdit) && baseEffort === "low" ? REASONING_EFFORT_HARD : baseEffort;

  const maxTokens = isPlan
    ? MAX_PLAN_TOKENS
    : isEdit
      ? MAX_EDIT_TOKENS
      : MAX_OUTPUT_TOKENS;

  try {
    // `reasoning` ve `usage` OpenRouter'a özgü alanlar, OpenAI tiplerinde yok.
    const params = {
      model: MODEL,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      reasoning: { effort },
      messages: conversation,
    } as unknown as OpenAI.ChatCompletionCreateParamsStreaming;

    const stream = await client.chat.completions.create(params);

    const readable = new ReadableStream({
      async start(controller) {
        // İstemci bu işareti görüp gelen metni plan/yama/sayfa diye ayırır.
        controller.enqueue(line({ m: isPlan ? "plan" : isEdit ? "edit" : "create" }));
        for (const note of notes) controller.enqueue(line({ n: note }));

        try {
          for await (const chunk of stream) {
            const delta = chunk.choices?.[0]?.delta as
              | { content?: string | null; reasoning?: string | null }
              | undefined;

            if (delta?.reasoning) controller.enqueue(line({ r: delta.reasoning }));
            if (delta?.content) controller.enqueue(line({ c: delta.content }));

            if (chunk.usage) controller.enqueue(line({ u: chunk.usage }));
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Bilinmeyen hata";
          controller.enqueue(line({ n: `Akış hatası: ${message}` }));
        } finally {
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
  } catch (err) {
    const message = err instanceof Error ? err.message : "Bilinmeyen hata";
    return new Response(`Model çağrısı başarısız: ${message}`, { status: 502 });
  }
}
