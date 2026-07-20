"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Logo, SLOGAN } from "./logo";
import { applyPatches } from "@/lib/patch";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  /** Bitiş mesajını renklendirmek için: iş tamamlandı mı, kısmen mi. */
  tone?: "ok" | "warn";
};
type Project = { id: string; title: string; updated_at: string };
type Version = {
  id: string;
  prompt: string | null;
  cost: number | null;
  share_slug: string | null;
  created_at: string;
  html?: string;
};

/** Model bazen ```html ... ``` sarmalıyla döndürür; onu temizler. */
function extractHtml(raw: string): string {
  const fenced = raw.match(/```(?:html)?\s*([\s\S]*?)(?:```|$)/i);
  return (fenced ? fenced[1] : raw).trim();
}

/**
 * Önizlemeye basılacak HTML'i hazırlar.
 *
 * Üretilen sayfadaki bağlantılara tıklanınca çerçeve o adrese gitmeye
 * çalışıyor; adres bizim uygulamamıza ait olduğu için şifre kapısına takılıp
 * giriş ekranı çerçevenin İÇİNDE açılıyordu. Üstelik sandbox form gönderimini
 * engellediği için orada giriş de yapılamıyordu.
 *
 * Önizleme gezinmek için değil bakmak için — bağlantı ve form gönderimlerini
 * durduruyoruz. Hover, animasyon, açılır menü gibi her şey çalışmaya devam eder.
 */
function previewDoc(html: string): string {
  if (!html) return html;

  const guard = `<script>
document.addEventListener('click', function (e) {
  var a = e.target && e.target.closest && e.target.closest('a[href]');
  if (a) e.preventDefault();
}, true);
document.addEventListener('submit', function (e) { e.preventDefault(); }, true);
</script>`;

  // </head> varsa oraya, yoksa başa ekle.
  return html.includes("</head>")
    ? html.replace("</head>", `${guard}</head>`)
    : guard + html;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const EMPTY_STATE = `<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#fff;
       font-family:ui-sans-serif,system-ui,sans-serif;color:#c4b5ae}
  p{font-size:13px}
</style></head>
<body><p>Tasarım burada görünecek</p></body></html>`;

const EXAMPLES = [
  "IP67 su geçirmez kutular için seçim rehberi sayfası",
  "Hero'ya ölçüden ve uygulamadan başlama girişleri ekle",
  "Ürün ailelerini karşılaştırma tablosuna çevir",
];

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [html, setHtml] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState(false);
  const [status, setStatus] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [cost, setCost] = useState<number | null>(null);

  // Kalıcılık
  const [dbReady, setDbReady] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [showProjects, setShowProjects] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  const [elapsed, setElapsed] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming]);

  // Uzun süren üretimlerde "takıldı mı" hissini önlemek için geçen süre sayacı.
  useEffect(() => {
    if (!streaming) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [streaming]);

  // Açılışta projeleri yükle. 503 gelirse Supabase yok demektir —
  // araç yine çalışır, sadece kayıt tutmaz.
  useEffect(() => {
    fetch("/api/projects")
      .then(async (r) => {
        if (!r.ok) return null;
        return r.json();
      })
      .then((data) => {
        if (!data) return;
        setDbReady(true);
        setProjects(data.projects ?? []);
        // Sayfa yenilendiğinde son çalışılan proje kendiliğinden açılsın —
        // aksi halde her yenilemede her şey kaybolmuş gibi görünüyor.
        const latest = data.projects?.[0];
        if (latest) loadProject(latest.id);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadProject = useCallback(async (id: string) => {
    const res = await fetch(`/api/projects/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    setProject(data.project);
    setVersions(data.versions ?? []);
    setShowProjects(false);
    setShareUrl(null);
    setMessages([]);
    const latest = data.versions?.[0];
    if (latest?.html) {
      setHtml(latest.html);
      setVersionId(latest.id);
    } else {
      setHtml("");
      setVersionId(null);
    }
  }, []);

  async function ensureProject(firstPrompt: string): Promise<Project | null> {
    if (project) return project;
    if (!dbReady) return null;
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: firstPrompt.slice(0, 60) }),
    });
    if (!res.ok) return null;
    const { project: created } = await res.json();
    setProject(created);
    setProjects((prev) => [created, ...prev]);
    return created;
  }

  async function saveVersion(
    target: Project | null,
    nextHtml: string,
    prompt: string,
    spent: number | null,
  ) {
    if (!target || !nextHtml) return;
    const res = await fetch("/api/versions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: target.id,
        html: nextHtml,
        prompt,
        cost: spent,
      }),
    });
    if (!res.ok) return;
    const { version } = await res.json();
    setVersions((prev) => [{ ...version, html: nextHtml }, ...prev]);
    setVersionId(version.id);
    setShareUrl(null);
  }

  async function send(preset?: string) {
    const text = (preset ?? input).trim();
    if (!text || streaming) return;

    setError(null);
    setNotes([]);
    setCost(null);
    setStatus(text.includes("http") ? "Sayfa taranıyor…" : "Düşünüyor…");
    setInput("");
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setStreaming(true);

    const target = await ensureProject(text);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages, currentHtml: html || undefined }),
      });

      if (!res.ok || !res.body) {
        setError(await res.text());
        setStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";
      let mode: "create" | "edit" = "create";
      let spent: number | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const raw of lines) {
          if (!raw.trim()) continue;
          let msg: {
            c?: string;
            r?: string;
            n?: string;
            m?: "create" | "edit";
            u?: { cost?: number };
          };
          try {
            msg = JSON.parse(raw);
          } catch {
            continue;
          }

          if (msg.m) mode = msg.m;
          if (msg.n) setNotes((prev) => [...prev, msg.n!]);
          if (msg.r) setStatus("Düşünüyor…");
          if (msg.u?.cost != null) {
            spent = msg.u.cost;
            setCost(msg.u.cost);
          }
          if (msg.c) {
            accumulated += msg.c;
            // Önizlemeyi akış sırasında GÜNCELLEMİYORUZ. Yarım HTML basmak
            // iframe'i her seferinde yeniden yükletiyor; ekran titriyor ve
            // sayfa bozukmuş gibi görünüyor. Sonucu bir kerede basıyoruz.
            setStatus(mode === "edit" ? "Değişiklik hazırlanıyor…" : "Sayfa yazılıyor…");
          }
        }
      }

      let reply = "Sayfa hazır — sağda görebilirsin.";
      let tone: "ok" | "warn" = "ok";
      let finalHtml = "";

      if (mode === "edit") {
        const result = applyPatches(html, accumulated);
        finalHtml = result.html;
        setHtml(result.html);
        setNotes((prev) => [...prev, ...result.notes]);
        if (result.applied === 0) {
          reply = "Değişikliği uygulayamadım — isteği biraz daha net yazar mısın?";
          tone = "warn";
        } else if (result.failed > 0) {
          reply = `${result.applied} değişiklik uygulandı, ${result.failed} tanesi tutmadı.`;
          tone = "warn";
        } else {
          reply = "Değişiklik uygulandı.";
        }
        if (result.applied > 0) await saveVersion(target, finalHtml, text, spent);
      } else {
        finalHtml = extractHtml(accumulated);
        setHtml(finalHtml);
        await saveVersion(target, finalHtml, text, spent);
      }

      setMessages([...nextMessages, { role: "assistant", content: reply, tone }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Beklenmeyen bir hata oluştu.");
    } finally {
      setStreaming(false);
      setStatus("");
    }
  }

  async function share() {
    if (!versionId) return;
    const res = await fetch("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ versionId }),
    });
    if (!res.ok) {
      setError(await res.text());
      return;
    }
    const { slug } = await res.json();
    setShareUrl(`${window.location.origin}/p/${slug}`);
    setCopied(false);
  }

  async function copyShare() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function restore(v: Version) {
    if (v.html) {
      setHtml(v.html);
      setVersionId(v.id);
      setShareUrl(null);
    }
  }

  function download() {
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sayfa.html";
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Proje adını değiştirir. */
  async function renameProject(id: string) {
    const title = editingTitle.trim();
    setEditingId(null);
    if (!title) return;

    const res = await fetch(`/api/projects/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      setError(await res.text());
      return;
    }
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, title } : p)));
    setProject((prev) => (prev && prev.id === id ? { ...prev, title } : prev));
  }

  /** Projeyi ve tüm versiyonlarını siler. Geri alınamaz. */
  async function removeProject(id: string) {
    const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError(await res.text());
      return;
    }
    setProjects((prev) => prev.filter((p) => p.id !== id));
    setConfirmDelete(null);
    if (project?.id === id) newProject();
  }

  function newProject() {
    setProject(null);
    setVersions([]);
    setVersionId(null);
    setHtml("");
    setMessages([]);
    setShareUrl(null);
    setShowProjects(false);
  }

  return (
    <main className="flex h-screen bg-[#fff7f3] text-stone-700">
      {/* SOL — sohbet */}
      <section className="flex w-[380px] shrink-0 flex-col">
        <header className="px-7 py-6">
          <div className="flex items-center gap-2.5">
            <Logo />
            <div className="leading-none">
              <div className="text-[17px] font-semibold tracking-tight text-stone-800">
                Rukible
              </div>
              <div className="mt-1 text-[11px] text-orange-400">{SLOGAN}</div>
            </div>
          </div>

          {dbReady && (
            <div className="mt-4 flex items-center gap-2 text-[11px]">
              <button
                onClick={() => {
                  setShowProjects((s) => !s);
                  setConfirmDelete(null);
                }}
                className="truncate rounded-full bg-white/70 px-3 py-1 text-stone-500 transition hover:bg-white hover:text-stone-800"
              >
                {project ? project.title : "Yeni proje"} ▾
              </button>
              {project && (
                <button
                  onClick={newProject}
                  className="text-stone-400 transition hover:text-stone-700"
                >
                  + yeni
                </button>
              )}
            </div>
          )}

          {showProjects && (
            <div className="mt-2 space-y-1">
              {projects.length === 0 && (
                <p className="text-[11px] text-stone-400">Henüz proje yok</p>
              )}
              {projects.map((p) => (
                <div key={p.id} className="flex items-center gap-1">
                  {editingId === p.id ? (
                    <input
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") renameProject(p.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      onBlur={() => renameProject(p.id)}
                      autoFocus
                      className="min-w-0 flex-1 rounded-xl bg-white px-3 py-1.5 text-[12px] text-stone-800 outline-none"
                    />
                  ) : (
                    <button
                      onClick={() => {
                        setConfirmDelete(null);
                        loadProject(p.id);
                      }}
                      className={`min-w-0 flex-1 truncate rounded-xl px-3 py-1.5 text-left text-[12px] transition hover:bg-white/70 hover:text-stone-800 ${
                        project?.id === p.id ? "text-stone-800" : "text-stone-500"
                      }`}
                    >
                      {p.title}
                    </button>
                  )}

                  {confirmDelete === p.id ? (
                    <span className="flex shrink-0 items-center gap-1 pr-1">
                      <button
                        onClick={() => removeProject(p.id)}
                        className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] text-rose-700 transition hover:bg-rose-200"
                      >
                        sil
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="px-1 text-[11px] text-stone-400 transition hover:text-stone-600"
                      >
                        vazgeç
                      </button>
                    </span>
                  ) : (
                    editingId !== p.id && (
                      <span className="flex shrink-0 items-center">
                        <button
                          onClick={() => {
                            setEditingId(p.id);
                            setEditingTitle(p.title);
                            setConfirmDelete(null);
                          }}
                          title="Adını değiştir"
                          className="px-1.5 text-[11px] text-stone-300 transition hover:text-stone-600"
                        >
                          adlandır
                        </button>
                        <button
                          onClick={() => setConfirmDelete(p.id)}
                          title="Projeyi sil"
                          className="px-1.5 text-[13px] leading-none text-stone-300 transition hover:text-rose-500"
                        >
                          ×
                        </button>
                      </span>
                    )
                  )}
                </div>
              ))}
            </div>
          )}
        </header>

        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-7 pb-4">
          {messages.length === 0 && !streaming && (
            <div className="space-y-2.5">
              <p className="text-xs text-stone-400">Şunları deneyebilirsin</p>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => send(ex)}
                  className="block w-full rounded-2xl bg-white/70 px-4 py-3 text-left text-[13px] leading-snug text-stone-500 transition hover:bg-white hover:text-stone-800"
                >
                  {ex}
                </button>
              ))}
            </div>
          )}

          {messages.map((m, i) =>
            m.role === "user" ? (
              <div
                key={i}
                className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-orange-100/80 px-4 py-2.5 text-[13px] leading-relaxed text-stone-700"
              >
                {m.content}
              </div>
            ) : m.tone ? (
              <p
                key={i}
                className={`flex items-start gap-2 rounded-2xl px-4 py-2.5 text-[13px] leading-relaxed ${
                  m.tone === "ok"
                    ? "bg-emerald-50 text-emerald-800"
                    : "bg-amber-50 text-amber-800"
                }`}
              >
                <span aria-hidden="true">{m.tone === "ok" ? "✓" : "!"}</span>
                {m.content}
              </p>
            ) : (
              <p key={i} className="text-[13px] leading-relaxed text-stone-400">
                {m.content}
              </p>
            ),
          )}

          {notes.map((n, i) => (
            <p key={i} className="text-[11px] text-stone-400">
              ✳︎ {n}
            </p>
          ))}

          {streaming && (
            <p className="flex items-center gap-2 text-[13px] text-stone-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange-400" />
              {status || "Çiziliyor…"}
            </p>
          )}

          {!streaming && cost != null && (
            <p className="text-[11px] text-stone-400">Bu üretim: ${cost.toFixed(4)}</p>
          )}

          {error && (
            <p className="rounded-2xl bg-rose-100/70 px-4 py-3 text-xs leading-relaxed text-rose-700">
              {error}
            </p>
          )}
        </div>

        <div className="px-7 pb-7">
          <div className="rounded-3xl bg-white/80 p-2 shadow-[0_1px_3px_rgba(120,80,60,0.06)]">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={3}
              placeholder="Nasıl bir sayfa olsun?"
              className="w-full resize-none bg-transparent px-3 py-2 text-[13px] leading-relaxed text-stone-700 outline-none placeholder:text-stone-300"
            />
            <button
              onClick={() => send()}
              disabled={streaming || !input.trim()}
              className="w-full rounded-2xl bg-orange-400 py-2.5 text-[13px] font-medium text-white transition hover:bg-orange-500 disabled:bg-stone-100 disabled:text-stone-300"
            >
              {streaming ? "Çiziliyor…" : "Gönder"}
            </button>
          </div>
        </div>
      </section>

      {/* SAĞ — önizleme */}
      <section className="flex flex-1 flex-col pr-4">
        <header className="flex items-center justify-between gap-4 py-6 pl-2 pr-4">
          <div className="flex gap-1 rounded-full bg-white/70 p-1 text-xs">
            <button
              onClick={() => setMobileView(false)}
              className={`rounded-full px-3 py-1 transition ${
                !mobileView ? "bg-orange-400 text-white" : "text-stone-400 hover:text-stone-600"
              }`}
            >
              Masaüstü
            </button>
            <button
              onClick={() => setMobileView(true)}
              className={`rounded-full px-3 py-1 transition ${
                mobileView ? "bg-orange-400 text-white" : "text-stone-400 hover:text-stone-600"
              }`}
            >
              Mobil
            </button>
          </div>

          <div className="flex items-center gap-3 text-xs">
            {shareUrl && (
              <button
                onClick={copyShare}
                title={shareUrl}
                className="max-w-[260px] truncate rounded-full bg-white px-3 py-1 text-stone-600 transition hover:text-stone-900"
              >
                {copied ? "kopyalandı ✳︎" : shareUrl.replace(/^https?:\/\//, "")}
              </button>
            )}
            <button
              onClick={share}
              disabled={!versionId}
              className="rounded-full px-3 py-1 text-stone-500 transition hover:bg-white/70 hover:text-stone-900 disabled:text-stone-300 disabled:hover:bg-transparent"
            >
              Paylaş
            </button>
            <button
              onClick={download}
              disabled={!html}
              className="rounded-full px-3 py-1 text-stone-400 transition hover:bg-white/70 hover:text-stone-700 disabled:text-stone-300 disabled:hover:bg-transparent"
            >
              İndir
            </button>
          </div>
        </header>

        {versions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pb-3 pl-2 text-[11px]">
            <span className="py-1 text-stone-400">Geçmiş</span>
            {versions.map((v, i) => (
              <button
                key={v.id}
                onClick={() => restore(v)}
                title={v.prompt ?? ""}
                className={`rounded-full px-2.5 py-1 transition ${
                  v.id === versionId
                    ? "bg-orange-400 text-white"
                    : "bg-white/70 text-stone-500 hover:bg-white hover:text-stone-800"
                }`}
              >
                v{versions.length - i} · {clock(v.created_at)}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-1 justify-center overflow-hidden pb-6 pl-2">
          <div
            className={`relative h-full transition-all ${
              mobileView ? "w-[390px]" : "w-full"
            }`}
          >
            <iframe
              title="Önizleme"
              srcDoc={html ? previewDoc(html) : EMPTY_STATE}
              sandbox="allow-scripts"
              className={`h-full w-full rounded-3xl bg-white shadow-[0_2px_16px_rgba(120,80,60,0.08)] transition-opacity duration-500 ${
                streaming ? "opacity-40" : "opacity-100"
              }`}
            />

            {streaming && (
              <div className="absolute inset-0 grid place-items-center rounded-3xl bg-[#fff7f3]/70 backdrop-blur-[2px]">
                <div className="flex flex-col items-center gap-3">
                  <span className="h-7 w-7 animate-spin rounded-full border-2 border-orange-200 border-t-orange-400" />
                  <span className="text-[13px] text-stone-500">
                    {status || "Çiziliyor…"}
                  </span>
                  <span className="text-[11px] tabular-nums text-stone-400">
                    {Math.floor(elapsed / 60)}:
                    {String(elapsed % 60).padStart(2, "0")}
                  </span>
                  {elapsed > 45 && (
                    <span className="max-w-[220px] text-center text-[11px] leading-relaxed text-stone-400">
                      Yeni sayfa üretimi birkaç dakika sürebilir, sorun yok.
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
