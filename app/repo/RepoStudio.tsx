"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { Logo, SLOGAN } from "../logo";
import { readNdjson } from "@/lib/streamChat";
import { downloadText } from "@/lib/download";
import { fileToDataUrl } from "@/lib/imageAttach";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  tone?: "ok" | "warn";
  /** true ise bu asistan mesajı bir plandır; altında "Uygula" düğmesi çıkar. */
  plan?: boolean;
  /** true ise kullanıcı bu mesaja bir görsel iliştirdi (sohbette işaret gösterilir). */
  hasImage?: boolean;
};
type RepoProject = {
  id: string;
  title: string;
  kind?: string;
  repo_url?: string | null;
  updated_at: string;
};
type RepoChange = {
  path: string;
  status: "added" | "modified" | "deleted";
  diff?: string;
  content?: string;
};
type TreeEntry = { path: string; type: "file" | "dir"; size?: number };

/** Repoda sunulabilir statik bir HTML girişi var mı? */
function hasStaticEntry(tree: TreeEntry[]): boolean {
  return tree.some((t) => t.type === "file" && t.path.endsWith(".html"));
}

/** Çatı projesi ipucu (önizleme neden çalışmadığını açıklamak için). */
function detectFramework(tree: TreeEntry[]): string | null {
  const p = tree.map((t) => t.path);
  if (p.some((x) => /(^|\/)next\.config\.(js|ts|mjs|cjs)$/.test(x))) return "Next.js";
  if (p.some((x) => /(^|\/)nuxt\.config\./.test(x))) return "Nuxt";
  if (p.some((x) => /(^|\/)(vite|svelte|astro)\.config\./.test(x)))
    return "bir çatı (Vite/Svelte/Astro)";
  if (p.some((x) => /(^|\/)angular\.json$/.test(x))) return "Angular";
  if (p.some((x) => /(^|\/)package\.json$/.test(x))) return "bir JS/çatı";
  return null;
}

const CHAT_KEY = (id: string) => `rukible_repo_chat_v1_${id}`;

function saveChatToDb(projectId: string, msgs: ChatMessage[]): void {
  fetch(`/api/projects/${projectId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat: msgs }),
  }).catch(() => {});
}

function statusChip(s: RepoChange["status"]) {
  if (s === "added") return { label: "+ eklendi", cls: "bg-emerald-100 text-emerald-700" };
  if (s === "deleted") return { label: "− silindi", cls: "bg-rose-100 text-rose-700" };
  return { label: "~ değişti", cls: "bg-amber-100 text-amber-700" };
}

export default function RepoStudio({
  initialProjectId,
}: {
  initialProjectId: string | null;
}) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [repoUrl, setRepoUrl] = useState("");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [steps, setSteps] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"build" | "plan">("build");
  const [cost, setCost] = useState(0);
  // Sıradaki mesaja iliştirilecek görsel (ekran görüntüsü / projeye eklenecek
  // foto) — data URL. Orijinal dosya küçükse format bozulmadan taşınır ki ajan
  // save_image ile projeye birebir kaydedebilsin.
  const [pendingImage, setPendingImage] = useState<string | null>(null);

  const [tab, setTab] = useState<"preview" | "changes" | "files">("preview");

  // Elle dosya düzenleme
  const [editPath, setEditPath] = useState("");
  const [editContent, setEditContent] = useState("");
  /** Diskten okunan hali — "kaydedilmemiş değişiklik var mı" bunun farkı. */
  const [editOriginal, setEditOriginal] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState("");
  const [fileFilter, setFileFilter] = useState("");
  const [previewPath, setPreviewPath] = useState("");
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [previewKey, setPreviewKey] = useState(0);

  // Çatı önizlemesi (dev sunucusu)
  const [devStatus, setDevStatus] = useState<
    "idle" | "installing" | "starting" | "ready" | "error" | "stopped"
  >("idle");
  const [devPort, setDevPort] = useState<number | null>(null);
  // Önizleme iframe'inin bağlandığı port (dev sunucusunun önündeki çerçeve
  // proxy'si — Firefox'taki sonsuz yenilenme döngüsünü önler).
  const [framePort, setFramePort] = useState<number | null>(null);
  const [devLogs, setDevLogs] = useState<string[]>([]);
  const [devError, setDevError] = useState("");
  const devPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [changes, setChanges] = useState<RepoChange[]>([]);
  const [selected, setSelected] = useState(0);

  // Boş durum (proje seçili değil): klonlama ekranı
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState("");
  const [projects, setProjects] = useState<RepoProject[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [style, setStyle] = useState("muhendis");
  const [tokens, setTokens] = useState(0);
  const [usage, setUsage] = useState<{ kalan?: number; limit?: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Görsel seçildiğinde: data URL'e çevir, sıradaki mesaja iliştir. */
  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // aynı dosyayı tekrar seçebilmek için sıfırla
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Sadece görsel (resim) eklenebilir.");
      return;
    }
    try {
      // 3 MB altı dosyalar olduğu gibi taşınır (şeffaf PNG bozulmasın);
      // daha büyükleri küçültülüp JPEG'e çevrilir.
      setPendingImage(await fileToDataUrl(file, { keepOriginalUnder: 3_000_000 }));
    } catch {
      setError("Görsel işlenemedi.");
    }
  }

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (!res.ok) return;
      const data = await res.json();
      const repos: RepoProject[] = (data.projects ?? []).filter(
        (p: RepoProject) => p.kind === "repo",
      );
      setProjects(repos);
    } catch {
      // DB yoksa sessiz
    }
  }, []);

  const loadUsage = useCallback(async () => {
    try {
      const r = await fetch("/api/kullanim");
      if (r.ok) setUsage(await r.json());
    } catch {
      // yoksay
    }
  }, []);

  const refreshChanges = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/repo/changes?projectId=${id}`);
      if (!res.ok) return;
      const data = await res.json();
      setChanges(data.files ?? []);
      setSelected(0);
    } catch {
      // yoksay
    }
  }, []);

  const clearDevPoll = useCallback(() => {
    if (devPollRef.current) {
      clearInterval(devPollRef.current);
      devPollRef.current = null;
    }
  }, []);

  const pollDev = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/repo/dev?projectId=${id}`);
        if (!res.ok) return;
        const d = await res.json();
        setDevStatus(d.status);
        if (d.port) setDevPort(d.port);
        if (d.framePort) setFramePort(d.framePort);
        if (Array.isArray(d.logs)) setDevLogs(d.logs);
        if (d.error) setDevError(d.error);
        if (d.status === "ready" || d.status === "error" || d.status === "stopped") {
          clearDevPoll();
        }
      } catch {
        // yoksay
      }
    },
    [clearDevPoll],
  );

  // Bir repo projesini aç: DB'den bilgiyi al, çalışma kopyasını hazırla.
  const openProject = useCallback(
    async (id: string) => {
      setCloneError("");
      setCloning(true);
      try {
        const info = await fetch(`/api/projects/${id}`).then((r) =>
          r.ok ? r.json() : null,
        );
        const proj = info?.project;
        const url = proj?.repo_url as string | undefined;
        if (!url) {
          setCloneError("Bu projenin repo adresi yok.");
          setCloning(false);
          return;
        }
        // Klasör varsa yeniden kullanır, yoksa klonlar (düzenlemeleri korur).
        const res = await fetch("/api/repo/clone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: id, url }),
        });
        if (!res.ok) {
          setCloneError(await res.text());
          setCloning(false);
          return;
        }
        const data = await res.json();
        clearDevPoll();
        setDevStatus("idle");
        setDevPort(null);
        setFramePort(null);
        setDevLogs([]);
        resetEditor();
        setProjectId(id);
        setTitle(proj.title ?? "Proje");
        setRepoUrl(url);
        setTree(data.tree ?? []);
        setPreviewPath(data.defaultFile ?? "");
        setPreviewKey((k) => k + 1);
        // Sohbeti getir (varsa)
        const chat = Array.isArray(proj?.chat) ? (proj.chat as ChatMessage[]) : [];
        const local = localStorage.getItem(CHAT_KEY(id));
        const localMsgs = local ? (JSON.parse(local) as ChatMessage[]) : [];
        setMessages(chat.length >= localMsgs.length ? chat : localMsgs);
        await refreshChanges(id);
        // Zaten çalışan bir dev sunucusu varsa hemen benimse (eski/ölü porta
        // takılmadan doğru portu göster).
        try {
          const dev = await fetch(`/api/repo/dev?projectId=${id}`).then((r) =>
            r.ok ? r.json() : null,
          );
          if (dev && dev.status === "ready" && dev.port) {
            setDevStatus("ready");
            setDevPort(dev.port);
            if (dev.framePort) setFramePort(dev.framePort);
          }
        } catch {
          // yoksay
        }
      } catch (e) {
        setCloneError(e instanceof Error ? e.message : "Açılamadı.");
      } finally {
        setCloning(false);
      }
    },
    [refreshChanges, clearDevPoll],
  );

  useEffect(() => {
    // Async yükleme: setState hep await sonrası olur (senkron kademeli render yok).
    void (async () => {
      await loadProjects();
      void loadUsage();
      if (initialProjectId) await openProject(initialProjectId);
    })();
  }, [initialProjectId, loadProjects, openProject, loadUsage]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, liveText, steps]);

  // Poll aralığını bileşen kaldırılınca temizle.
  useEffect(() => () => clearDevPoll(), [clearDevPoll]);

  // Yeni repo klonla
  async function startClone() {
    const url = cloneUrl.trim();
    if (!url) return;
    setCloneError("");
    setCloning(true);
    try {
      const res = await fetch("/api/repo/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        setCloneError(await res.text());
        return;
      }
      const data = await res.json();
      clearDevPoll();
      setDevStatus("idle");
      setDevPort(null);
      setFramePort(null);
      setDevLogs([]);
      resetEditor();
      setProjectId(data.projectId);
      setRepoUrl(url);
      setTree(data.tree ?? []);
      setPreviewPath(data.defaultFile ?? "");
      setPreviewKey((k) => k + 1);
      setMessages([]);
      setChanges([]);
      // Başlığı listeden çek
      await loadProjects();
      const info = await fetch(`/api/projects/${data.projectId}`).then((r) =>
        r.ok ? r.json() : null,
      );
      setTitle(info?.project?.title ?? "Proje");
    } catch (e) {
      setCloneError(e instanceof Error ? e.message : "Klonlanamadı.");
    } finally {
      setCloning(false);
    }
  }

  async function reclone() {
    if (!projectId || !repoUrl || streaming) return;
    if (!confirm("Repoyu yeniden klonla? Yaptığın değişiklikler silinir.")) return;
    setCloning(true);
    try {
      const res = await fetch("/api/repo/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, url: repoUrl, refresh: true }),
      });
      if (res.ok) {
        const data = await res.json();
        setPreviewPath(data.defaultFile ?? "");
        setPreviewKey((k) => k + 1);
        resetEditor();
        await refreshChanges(projectId);
      }
    } finally {
      setCloning(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  async function startDev() {
    if (!projectId) return;
    setDevError("");
    setDevLogs([]);
    setDevStatus("installing");
    try {
      const res = await fetch("/api/repo/dev", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        setDevStatus("error");
        setDevError(await res.text());
        return;
      }
      const d = await res.json();
      setDevStatus(d.status);
      if (d.port) setDevPort(d.port);
      if (d.framePort) setFramePort(d.framePort);
      clearDevPoll();
      devPollRef.current = setInterval(() => pollDev(projectId), 2000);
    } catch (e) {
      setDevStatus("error");
      setDevError((e as Error).message);
    }
  }

  async function stopDev() {
    clearDevPoll();
    if (projectId) {
      await fetch(`/api/repo/dev?projectId=${projectId}`, { method: "DELETE" }).catch(
        () => {},
      );
    }
    setDevStatus("idle");
    setDevPort(null);
    setFramePort(null);
    setDevLogs([]);
    setDevError("");
  }

  /** Proje/çalışma kopyası değişince açık dosyayı bırak (içerik artık geçersiz). */
  function resetEditor() {
    setEditPath("");
    setEditContent("");
    setEditOriginal("");
    setEditError("");
    setFileFilter("");
    setPendingImage(null);
  }

  /** Dosyayı diskten okuyup düzenleyiciye alır. */
  async function openFile(path: string) {
    if (!projectId) return;
    if (editPath && editContent !== editOriginal) {
      if (!confirm(`"${editPath}" içindeki kaydedilmemiş değişiklikler kaybolacak. Devam?`)) {
        return;
      }
    }
    setEditError("");
    setEditBusy(true);
    try {
      const res = await fetch(
        `/api/repo/file?projectId=${projectId}&path=${encodeURIComponent(path)}`,
      );
      if (!res.ok) {
        setEditError(await res.text());
        setEditPath("");
        return;
      }
      const data = await res.json();
      setEditPath(path);
      setEditContent(data.content);
      setEditOriginal(data.content);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "Dosya açılamadı.");
    } finally {
      setEditBusy(false);
    }
  }

  /** Düzenlenen dosyayı diske yazar; sonra diff'i ve önizlemeyi tazeler. */
  async function saveFile() {
    if (!projectId || !editPath || editBusy) return;
    setEditError("");
    setEditBusy(true);
    try {
      const res = await fetch("/api/repo/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, path: editPath, content: editContent }),
      });
      if (!res.ok) {
        setEditError(await res.text());
        return;
      }
      setEditOriginal(editContent);
      await refreshChanges(projectId);
      setPreviewKey((k) => k + 1);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "Kaydedilemedi.");
    } finally {
      setEditBusy(false);
    }
  }

  async function runAgent(
    text: string,
    useMode: "build" | "plan",
    img?: string | null,
  ) {
    // Görsel varsa metin olmadan da gönderilebilir.
    if ((!text && !img) || !projectId || streaming) return;

    // API'ye gerçek metni gönder; ekranda görselli boş mesajı "📷 Görsel" göster.
    const apiMessages = [...messages, { role: "user" as const, content: text }];
    const next: ChatMessage[] = [
      ...messages,
      { role: "user", content: text || "📷 Görsel", hasImage: !!img },
    ];
    setMessages(next);
    setStreaming(true);
    setLiveText("");
    setSteps([]);
    setNotes([]);
    setError("");

    const controller = new AbortController();
    abortRef.current = controller;

    let assistant = "";
    let yazilanDosya = 0;
    const stepAcc: string[] = [];

    try {
      const res = await fetch("/api/repo/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          mode: useMode,
          style,
          image: img || undefined,
          messages: apiMessages.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        setError(await res.text());
        setStreaming(false);
        return;
      }

      await readNdjson(res, (msg) => {
        if (msg.a) {
          assistant += (assistant ? "\n\n" : "") + msg.a;
          setLiveText(assistant);
        }
        if (msg.t) {
          stepAcc.push(`· ${msg.t}`);
          setSteps([...stepAcc]);
        }
        if (msg.w) {
          yazilanDosya++;
          stepAcc.push(`✎ ${msg.w}`);
          setSteps([...stepAcc]);
        }
        if (msg.n) setNotes((p) => [...p, msg.n!]);
        if (msg.u?.cost != null) setCost((c) => c + (msg.u!.cost || 0));
        if (msg.u?.total_tokens != null)
          setTokens((t) => t + (msg.u!.total_tokens || 0));
      });

      const finalMsgs: ChatMessage[] = [
        ...next,
        useMode === "plan"
          ? {
              role: "assistant",
              content: assistant.trim() || "Plan üretemedim, tekrar dener misin?",
              plan: true,
            }
          : yazilanDosya === 0
            ? {
                // Hiç dosya yazılmadıysa "Tamamlandı" demek yanıltıcı.
                role: "assistant",
                content:
                  assistant.trim() ||
                  "Hiçbir dosya değişmedi. İsteği daha somut yaz (hangi dosya/bölüm, ne olsun) ya da tekrar dene.",
                tone: "warn",
              }
            : { role: "assistant", content: assistant.trim() || "Tamamlandı.", tone: "ok" },
      ];
      setMessages(finalMsgs);
      setLiveText("");
      setSteps([]);
      localStorage.setItem(CHAT_KEY(projectId), JSON.stringify(finalMsgs));
      saveChatToDb(projectId, finalMsgs);
      void loadUsage(); // kalan krediyi tazele

      // Sadece build modunda dosya değişir → önizlemeyi tazele + diff getir.
      if (useMode === "build") {
        setPreviewKey((k) => k + 1);
        await refreshChanges(projectId);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setMessages([
          ...next,
          {
            role: "assistant",
            content: "Bir hata oldu: " + ((e as Error).message ?? ""),
            tone: "warn",
          },
        ]);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function send() {
    const text = input.trim();
    const img = pendingImage;
    if (!text && !img) return;
    setInput("");
    setPendingImage(null); // iliştirildi; kutuyu boşalt
    void runAgent(text, mode, img);
  }

  async function renameProject(id: string) {
    const t = editingTitle.trim();
    setEditingId(null);
    if (!t) return;
    await fetch(`/api/projects/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: t }),
    }).catch(() => {});
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, title: t } : p)));
  }

  async function removeProject(id: string) {
    setConfirmDelete(null);
    await fetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
    await fetch(`/api/repo/clone?projectId=${id}`, { method: "DELETE" }).catch(() => {});
    setProjects((prev) => prev.filter((p) => p.id !== id));
  }

  function applyPlan(planText: string) {
    void runAgent(`Şu planı uygula:\n\n${planText}`, "build");
  }

  // ---------- BOŞ DURUM: klonlama ekranı ----------
  if (!projectId) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#fff7f3] px-6 text-stone-700">
        <div className="w-full max-w-[440px]">
          <div className="mb-8 flex flex-col items-center text-center">
            <Logo size={92} />
            <div className="mt-3 text-2xl font-semibold tracking-tight text-stone-800">
              Repo üstünden düzenle
            </div>
            <div className="mt-1 text-[12px] text-orange-400">{SLOGAN}</div>
            <p className="mt-3 text-[13px] leading-relaxed text-stone-500">
              Herkese açık bir git repo linki yapıştır; Rukible klonlayıp dosyaların
              üstünde çalışsın, önizlemeyi sağda göstersin.
            </p>
          </div>

          <div className="rounded-2xl bg-white p-4 shadow-[0_1px_3px_rgba(120,80,60,0.08)]">
            <input
              value={cloneUrl}
              onChange={(e) => setCloneUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") startClone();
              }}
              placeholder="https://github.com/kullanici/proje"
              className="w-full rounded-xl bg-[#fff7f3] px-3 py-2.5 text-[13px] text-stone-700 outline-none placeholder:text-stone-300"
            />
            <button
              onClick={startClone}
              disabled={cloning || !cloneUrl.trim()}
              className="mt-2 w-full rounded-xl bg-orange-400 py-2.5 text-[13px] font-medium text-white transition hover:bg-orange-500 disabled:bg-stone-100 disabled:text-stone-300"
            >
              {cloning ? "Klonlanıyor…" : "Klonla ve başla"}
            </button>
            {cloneError && (
              <p className="mt-2 text-[12px] text-rose-600">{cloneError}</p>
            )}
          </div>

          {projects.length > 0 && (
            <div className="mt-6">
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-stone-400">
                Önceki projeler
              </div>
              <div className="space-y-1">
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
                        className="min-w-0 flex-1 rounded-xl bg-white px-3 py-2 text-[13px] text-stone-800 outline-none"
                      />
                    ) : (
                      <button
                        onClick={() => openProject(p.id)}
                        className="min-w-0 flex-1 truncate rounded-xl bg-white px-3 py-2 text-left text-[13px] text-stone-700 shadow-[0_1px_2px_rgba(120,80,60,0.06)] transition hover:bg-orange-50"
                      >
                        {p.title}
                      </button>
                    )}

                    {confirmDelete === p.id ? (
                      <span className="flex shrink-0 items-center gap-1">
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
                            className="rounded-lg px-2 py-1 text-[12px] text-stone-500 transition hover:bg-orange-100 hover:text-stone-900"
                          >
                            Adlandır
                          </button>
                          <button
                            onClick={() => setConfirmDelete(p.id)}
                            title="Projeyi sil"
                            className="rounded-lg px-2 py-1 text-[15px] leading-none text-stone-400 transition hover:bg-rose-100 hover:text-rose-600"
                          >
                            ×
                          </button>
                        </span>
                      )
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-6 text-center">
            <Link
              href="/"
              className="text-[12.5px] text-stone-400 transition hover:text-orange-500"
            >
              ← Başa dön
            </Link>
          </div>
        </div>
      </main>
    );
  }

  // ---------- ÇALIŞMA ALANI ----------
  const selectedChange = changes[selected];
  const devFw = detectFramework(tree);
  // Önizleme kaynağı:
  //  - LOKAL erişimde (localhost) ÇERÇEVE PROXY'sine bağlanır: dev sunucusunu
  //    birebir aynı yollarla sunar → uygulama native çalışır (HMR, hydration,
  //    mouse/animasyon etkileşimleri tam), üstüne `Timing-Allow-Origin` ekler.
  //    Bu başlık olmadan Firefox iframe'de sonsuz yenilenme döngüsüne giriyor
  //    (bkz. lib/devserver.ts → startFrameProxy). Proxy yoksa dev portuna düşer.
  //  - Uzak/tünel erişiminde Rukible origin'i üzerinden proxy'lenir (tek adres,
  //    ayrı port yönlendirmesi gerekmez) — görsel önizleme.
  const isLocalHost =
    typeof window !== "undefined" &&
    /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  const localPort = framePort ?? devPort;
  const previewSrc = projectId
    ? isLocalHost && localPort
      ? `http://localhost:${localPort}`
      : `/api/repo/live/${projectId}`
    : "";

  return (
    <main className="flex h-screen bg-[#fff7f3] text-stone-700">
      {/* SOL — sohbet */}
      <section className="flex w-[420px] shrink-0 flex-col overflow-hidden">
        <header className="px-7 py-6">
          <div className="flex items-center gap-3">
            <Logo size={38} />
            <div className="min-w-0 leading-none">
              <div className="truncate text-[17px] font-semibold tracking-tight text-stone-800">
                {title || "Proje"}
              </div>
              <div className="mt-1 truncate text-[11px] text-stone-400">{repoUrl}</div>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <Link
              href="/"
              className="rounded-xl bg-white px-3 py-1.5 text-[12px] font-medium text-stone-600 shadow-[0_1px_2px_rgba(120,80,60,0.06)] transition hover:bg-orange-50"
            >
              ← Başa dön
            </Link>
            <button
              onClick={() => {
                clearDevPoll();
                setDevStatus("idle");
                setDevPort(null);
                setFramePort(null);
                resetEditor();
                setProjectId(null);
                setMessages([]);
                loadProjects();
              }}
              className="rounded-xl bg-white px-3 py-1.5 text-[12px] font-medium text-stone-600 shadow-[0_1px_2px_rgba(120,80,60,0.06)] transition hover:bg-orange-50"
            >
              Başka proje
            </button>
            <button
              onClick={reclone}
              disabled={cloning || streaming}
              title="Repoyu yeniden klonla (değişiklikleri sıfırlar)"
              className="rounded-xl bg-white px-3 py-1.5 text-[12px] font-medium text-stone-500 shadow-[0_1px_2px_rgba(120,80,60,0.06)] transition hover:bg-orange-50 disabled:opacity-40"
            >
              ↻
            </button>
          </div>
        </header>

        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-7 pb-4">
          {messages.length === 0 && !streaming && (
            <p className="text-[13px] leading-relaxed text-stone-400">
              Ne yapmak istediğini yaz — örn. &quot;ana başlığı &apos;Altınkaya&apos;
              yap&quot; ya da &quot;iletişim bölümünün rengini koyulaştır&quot;.
            </p>
          )}

          {messages.map((m, i) =>
            m.role === "user" ? (
              <div
                key={i}
                className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-orange-100/80 px-4 py-2.5 text-[13px] leading-relaxed text-stone-700"
              >
                {m.hasImage && <span className="mr-1" aria-hidden="true">📷</span>}
                {m.content}
              </div>
            ) : m.plan ? (
              <div
                key={i}
                className="rounded-2xl border border-orange-200 bg-orange-50/60 px-4 py-3"
              >
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-orange-500">
                  <span aria-hidden="true">◇</span> Plan
                </div>
                <div className="whitespace-pre-line text-[13px] leading-relaxed text-stone-700">
                  {m.content}
                </div>
                <button
                  onClick={() => applyPlan(m.content)}
                  disabled={streaming}
                  className="mt-3 rounded-lg bg-orange-400 px-3.5 py-1.5 text-[12px] font-medium text-white transition hover:bg-orange-500 disabled:opacity-40"
                >
                  Uygula →
                </button>
              </div>
            ) : (
              <p
                key={i}
                className={`flex items-start gap-2 whitespace-pre-line px-1 text-[13px] leading-relaxed ${
                  m.tone === "warn" ? "text-amber-700" : "text-emerald-700"
                }`}
              >
                <span aria-hidden="true">{m.tone === "warn" ? "!" : "✓"}</span>
                {m.content}
              </p>
            ),
          )}

          {/* Canlı: çalışıyor göstergesi + araç adımları + oluşan yanıt */}
          {streaming && (
            <div className="flex items-center gap-2 px-1 text-[13px] text-stone-500">
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-orange-300 border-t-transparent" />
              {steps.length > 0 ? steps[steps.length - 1].replace(/^[·✎]\s*/, "") : "Çalışıyor…"}
            </div>
          )}
          {steps.length > 0 && (
            <div className="space-y-1 px-1">
              {steps.map((s, i) => (
                <p key={i} className="text-[12px] leading-relaxed text-stone-400">
                  {s}
                </p>
              ))}
            </div>
          )}
          {liveText && (
            <p className="whitespace-pre-line px-1 text-[13px] leading-relaxed text-stone-500">
              {liveText}
            </p>
          )}
          {notes.map((n, i) => (
            <p key={`n${i}`} className="px-1 text-[12px] text-amber-600">
              {n}
            </p>
          ))}
          {error && <p className="px-1 text-[12px] text-rose-600">{error}</p>}
        </div>

        <div className="px-7 pb-6 pt-2">
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-2">
              <div className="flex gap-1 rounded-full bg-white/70 p-1 text-[11px]">
                <button
                  onClick={() => setMode("build")}
                  className={`rounded-full px-3 py-1 transition ${
                    mode === "build"
                      ? "bg-orange-400 text-white"
                      : "text-stone-400 hover:text-stone-600"
                  }`}
                >
                  Build
                </button>
                <button
                  onClick={() => setMode("plan")}
                  className={`rounded-full px-3 py-1 transition ${
                    mode === "plan"
                      ? "bg-orange-400 text-white"
                      : "text-stone-400 hover:text-stone-600"
                  }`}
                >
                  Plan
                </button>
              </div>
              <select
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                title="Tasarım tercihi (görsel değişikliklerde bu ruha uyulur)"
                className="rounded-full bg-white/70 px-2.5 py-1.5 text-[11px] text-stone-600 outline-none"
              >
                <option value="muhendis">Mühendis</option>
                <option value="canli">Canlı</option>
                <option value="minimal">Minimal</option>
                <option value="serbest">Serbest</option>
                <option value="ruki">Ruki 🐵</option>
                <option value="ai">AI ✦</option>
              </select>
              <button
                onClick={() => fileRef.current?.click()}
                title="Görsel ekle — sorunlu yerin ekran görüntüsü ya da projeye eklenecek foto"
                className="rounded-full px-2 py-1 text-[13px] text-stone-400 transition hover:bg-orange-100 hover:text-stone-700"
              >
                📎
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                onChange={handleFile}
                className="hidden"
              />
            </div>
            <span className="shrink-0 text-[11px] text-stone-400">
              {usage?.kalan != null && (
                <span
                  className={
                    usage.kalan < 1 ? "font-medium text-rose-600" : "text-stone-500"
                  }
                >
                  Kalan ${usage.kalan.toFixed(2)}
                </span>
              )}
              {cost > 0 && ` · bu oturum $${cost.toFixed(4)}`}
              {tokens > 0 && ` · ${tokens.toLocaleString()} tk`}
            </span>
          </div>
          <div className="rounded-2xl bg-white p-2 shadow-[0_1px_3px_rgba(120,80,60,0.08)]">
            {/* İliştirilen görsel önizlemesi */}
            {pendingImage && (
              <div className="mb-1 flex items-center gap-2 px-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={pendingImage}
                  alt="eklenen görsel"
                  className="h-12 w-12 rounded-lg object-cover ring-1 ring-orange-200"
                />
                <span className="text-[11.5px] text-stone-500">Görsel eklendi</span>
                <button
                  onClick={() => setPendingImage(null)}
                  title="Görseli kaldır"
                  className="rounded-full px-1.5 text-[13px] text-stone-400 transition hover:text-rose-600"
                >
                  ×
                </button>
              </div>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder={
                mode === "plan"
                  ? "Ne yapalım? Önce planlayalım — dosya değişmez"
                  : "Ne değiştirelim?"
              }
              className="w-full resize-none overflow-y-auto bg-transparent px-3 py-2 text-[13px] leading-relaxed text-stone-700 outline-none placeholder:text-stone-300"
            />
            {streaming ? (
              <button
                onClick={stop}
                className="w-full rounded-2xl bg-stone-200 py-2.5 text-[13px] font-medium text-stone-700 transition hover:bg-stone-300"
              >
                Durdur
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!input.trim() && !pendingImage}
                className="w-full rounded-2xl bg-orange-400 py-2.5 text-[13px] font-medium text-white transition hover:bg-orange-500 disabled:bg-stone-100 disabled:text-stone-300"
              >
                {mode === "plan" ? "Planla" : "Gönder"}
              </button>
            )}
          </div>
        </div>
      </section>

      {/* SAĞ — önizleme / değişenler */}
      <section className="flex min-w-0 flex-1 flex-col pr-4">
        <header className="flex items-center justify-between gap-4 py-6 pl-2 pr-4">
          <div className="flex gap-1 rounded-full bg-white/70 p-1 text-xs">
            <button
              onClick={() => setTab("preview")}
              className={`rounded-full px-3 py-1 transition ${
                tab === "preview"
                  ? "bg-orange-400 text-white"
                  : "text-stone-400 hover:text-stone-600"
              }`}
            >
              Önizleme
            </button>
            <button
              onClick={() => setTab("files")}
              className={`rounded-full px-3 py-1 transition ${
                tab === "files"
                  ? "bg-orange-400 text-white"
                  : "text-stone-400 hover:text-stone-600"
              }`}
            >
              Dosyalar
              {editPath && editContent !== editOriginal ? " •" : ""}
            </button>
            <button
              onClick={() => setTab("changes")}
              className={`rounded-full px-3 py-1 transition ${
                tab === "changes"
                  ? "bg-orange-400 text-white"
                  : "text-stone-400 hover:text-stone-600"
              }`}
            >
              Değişenler{changes.length > 0 ? ` (${changes.length})` : ""}
            </button>
          </div>
          {tab === "preview" && (
            <button
              onClick={() => setPreviewKey((k) => k + 1)}
              className="rounded-xl bg-white px-3 py-1.5 text-[12.5px] font-medium text-stone-600 shadow-[0_1px_2px_rgba(120,80,60,0.06)] transition hover:bg-orange-50"
            >
              Yenile
            </button>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-hidden rounded-2xl bg-white shadow-[0_1px_3px_rgba(120,80,60,0.08)]">
          {tab === "preview" ? (
            previewPath && hasStaticEntry(tree) ? (
              <iframe
                key={previewKey}
                src={`/api/preview/${projectId}/${previewPath}`}
                sandbox="allow-scripts allow-forms allow-popups"
                className="h-full w-full border-0"
                title="Önizleme"
              />
            ) : (
              <div className="flex h-full flex-col">
                {/* dev sunucusu araç çubuğu */}
                <div className="flex items-center justify-between gap-2 border-b border-stone-100 px-3 py-2 text-[12px]">
                  <span className="truncate text-stone-500">
                    {devStatus === "ready"
                      ? `Çalışıyor${devFw ? ` · ${devFw}` : ""} · canlı önizleme`
                      : devStatus === "installing"
                        ? "Bağımlılıklar kuruluyor…"
                        : devStatus === "starting"
                          ? "Dev sunucusu başlatılıyor…"
                          : devStatus === "error"
                            ? "Başlatılamadı"
                            : `Canlı önizleme kapalı${devFw ? ` · ${devFw}` : ""}`}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {devStatus === "ready" && devPort && (
                      <a
                        href={previewSrc || "#"}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg bg-white px-2 py-1 text-[11.5px] text-stone-600 transition hover:bg-orange-50"
                      >
                        Yeni sekme ↗
                      </a>
                    )}
                    {devStatus === "installing" ||
                    devStatus === "starting" ||
                    devStatus === "ready" ? (
                      <button
                        onClick={stopDev}
                        className="rounded-lg bg-white px-2 py-1 text-[11.5px] text-stone-600 transition hover:bg-rose-50 hover:text-rose-600"
                      >
                        Durdur
                      </button>
                    ) : (
                      <button
                        onClick={startDev}
                        className="rounded-lg bg-orange-400 px-2.5 py-1 text-[11.5px] font-medium text-white transition hover:bg-orange-500"
                      >
                        ▸ Önizlemeyi başlat
                      </button>
                    )}
                  </span>
                </div>

                {/* gövde */}
                {devStatus === "ready" && devPort ? (
                  <iframe
                    key={previewKey}
                    src={previewSrc}
                    className="min-h-0 w-full flex-1 border-0"
                    title="Önizleme"
                  />
                ) : devStatus === "installing" || devStatus === "starting" ? (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <p className="px-4 pt-3 text-[13px] text-stone-500">
                      {devStatus === "installing"
                        ? "Projenin bağımlılıkları kuruluyor (ilk seferde birkaç dakika sürebilir)…"
                        : "Dev sunucusu başlatılıyor, hazır olunca site burada görünecek…"}
                    </p>
                    <pre className="mx-4 mb-4 mt-2 min-h-0 flex-1 overflow-auto rounded-lg bg-stone-900/95 p-3 text-[11px] leading-relaxed text-stone-200">
                      {devLogs.join("\n") || "…"}
                    </pre>
                  </div>
                ) : (
                  <div className="min-h-0 flex-1 overflow-auto p-6">
                    <div className="mx-auto max-w-md pt-6 text-center">
                      <div className="text-[15px] font-semibold text-stone-700">
                        Bu bir {devFw || "çatı"} projesi
                      </div>
                      <p className="mt-2 text-[13px] leading-relaxed text-stone-500">
                        Statik bir HTML dosyası yok; canlı önizleme için projenin
                        kendi dev sunucusunu çalıştırmam gerekiyor. Başlat dersen
                        Rukible bağımlılıkları kurup dev sunucusunu açar ve arayüzü
                        burada gösterir.
                      </p>
                      <p className="mt-2 text-[12px] leading-relaxed text-amber-600">
                        Not: bu, klonlanan reponun kendi kodunu çalıştırır. Kendi
                        (güvendiğin) repolarında sorun değil.
                      </p>
                      <button
                        onClick={startDev}
                        className="mt-4 rounded-xl bg-orange-400 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-orange-500"
                      >
                        ▸ Önizlemeyi başlat
                      </button>
                      {devError && (
                        <p className="mt-3 text-[12px] text-rose-600">{devError}</p>
                      )}
                      {devLogs.length > 0 && (
                        <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-stone-900/95 p-3 text-left text-[11px] leading-relaxed text-stone-200">
                          {devLogs.join("\n")}
                        </pre>
                      )}
                      <p className="mt-4 text-[12px] text-stone-400">
                        ({tree.filter((t) => t.type === "file").length} dosya klonlandı ·
                        dosyaları sohbetle düzenleyip “Değişenler”den kopyalayabilirsin.)
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )
          ) : tab === "files" ? (
            <div className="flex h-full">
              {/* dosya ağacı */}
              <div className="flex w-64 shrink-0 flex-col border-r border-stone-100">
                <div className="p-2">
                  <input
                    value={fileFilter}
                    onChange={(e) => setFileFilter(e.target.value)}
                    placeholder="Dosya ara…"
                    className="w-full rounded-lg bg-stone-50 px-2.5 py-1.5 text-[12px] outline-none ring-1 ring-stone-200 focus:ring-orange-300"
                  />
                </div>
                <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2 pt-0">
                  {tree
                    .filter((t) => t.type === "file")
                    .filter((t) =>
                      fileFilter
                        ? t.path.toLowerCase().includes(fileFilter.toLowerCase())
                        : true,
                    )
                    .slice(0, 500)
                    .map((t) => (
                      <button
                        key={t.path}
                        onClick={() => openFile(t.path)}
                        title={t.path}
                        className={`block w-full truncate rounded-lg px-2 py-1 text-left text-[12px] transition ${
                          editPath === t.path
                            ? "bg-orange-100 text-stone-700"
                            : "text-stone-500 hover:bg-orange-50"
                        }`}
                      >
                        {t.path}
                      </button>
                    ))}
                  {tree.filter((t) => t.type === "file").length === 0 && (
                    <p className="p-2 text-[12px] text-stone-400">Dosya yok.</p>
                  )}
                </div>
              </div>

              {/* düzenleyici */}
              <div className="flex min-w-0 flex-1 flex-col">
                {editPath ? (
                  <>
                    <div className="flex items-center justify-between gap-2 border-b border-stone-100 px-3 py-2">
                      <span className="truncate text-[12px] text-stone-500">
                        {editPath}
                        {editContent !== editOriginal && (
                          <span className="ml-1.5 text-orange-500">• kaydedilmedi</span>
                        )}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <button
                          onClick={() => setEditContent(editOriginal)}
                          disabled={editBusy || editContent === editOriginal}
                          className="rounded-lg bg-white px-2 py-1 text-[11.5px] text-stone-600 transition hover:bg-orange-50 disabled:opacity-40"
                        >
                          Geri al
                        </button>
                        <button
                          onClick={saveFile}
                          disabled={editBusy || editContent === editOriginal}
                          className="rounded-lg bg-orange-400 px-2.5 py-1 text-[11.5px] font-medium text-white transition hover:bg-orange-500 disabled:opacity-40"
                        >
                          {editBusy ? "Kaydediliyor…" : "Kaydet"}
                        </button>
                      </span>
                    </div>
                    {editError && (
                      <p className="border-b border-rose-100 bg-rose-50 px-3 py-2 text-[12px] text-rose-600">
                        {editError}
                      </p>
                    )}
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      onKeyDown={(e) => {
                        // Ctrl/Cmd+S ile kaydet — tarayıcının kaydet penceresini engelle.
                        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                          e.preventDefault();
                          void saveFile();
                        }
                      }}
                      spellCheck={false}
                      className="min-h-0 flex-1 resize-none bg-stone-900/95 p-3 font-[family-name:var(--font-mono)] text-[12px] leading-relaxed text-stone-100 outline-none"
                    />
                  </>
                ) : (
                  <div className="grid h-full place-items-center px-6 text-center">
                    <div>
                      <p className="text-[13px] text-stone-500">
                        Düzenlemek için soldan bir dosya seç.
                      </p>
                      <p className="mt-1.5 text-[12px] text-stone-400">
                        Kaydedince değişiklik &quot;Değişenler&quot; sekmesine düşer ve
                        önizleme tazelenir. (Ctrl/Cmd+S da kaydeder.)
                      </p>
                      {editError && (
                        <p className="mt-3 text-[12px] text-rose-600">{editError}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full">
              {/* değişen dosya listesi */}
              <div className="w-56 shrink-0 space-y-1 overflow-y-auto border-r border-stone-100 p-2">
                {changes.length === 0 && (
                  <p className="p-2 text-[12px] text-stone-400">Henüz değişiklik yok.</p>
                )}
                {changes.map((c, i) => {
                  const chip = statusChip(c.status);
                  return (
                    <button
                      key={c.path}
                      onClick={() => setSelected(i)}
                      className={`block w-full truncate rounded-lg px-2 py-1.5 text-left text-[12px] transition ${
                        i === selected ? "bg-orange-100 text-stone-900" : "hover:bg-orange-50"
                      }`}
                      title={c.path}
                    >
                      <span
                        className={`mr-1 rounded px-1 text-[10px] ${chip.cls}`}
                      >
                        {chip.label}
                      </span>
                      <span className="text-stone-600">{c.path.split("/").pop()}</span>
                    </button>
                  );
                })}
              </div>

              {/* seçili dosyanın diff'i */}
              <div className="flex min-w-0 flex-1 flex-col">
                {selectedChange ? (
                  <>
                    <div className="flex items-center justify-between gap-2 border-b border-stone-100 px-3 py-2">
                      <span className="truncate text-[12px] text-stone-500">
                        {selectedChange.path}
                      </span>
                      <span className="flex shrink-0 gap-2">
                        {selectedChange.content != null && (
                          <>
                            <button
                              onClick={() =>
                                navigator.clipboard.writeText(selectedChange.content ?? "")
                              }
                              className="rounded-lg bg-white px-2 py-1 text-[11.5px] text-stone-600 transition hover:bg-orange-50"
                            >
                              Kopyala
                            </button>
                            <button
                              onClick={() =>
                                downloadText(
                                  selectedChange.path.split("/").pop() || "dosya.txt",
                                  selectedChange.content ?? "",
                                )
                              }
                              className="rounded-lg bg-white px-2 py-1 text-[11.5px] text-stone-600 transition hover:bg-orange-50"
                            >
                              İndir
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto p-3">
                      <pre className="text-[12px] leading-relaxed">
                        {(selectedChange.diff || "(fark gösterilemiyor)")
                          .split("\n")
                          .map((ln, j) => {
                            let cls = "text-stone-500";
                            if (ln.startsWith("+") && !ln.startsWith("+++"))
                              cls = "text-emerald-600";
                            else if (ln.startsWith("-") && !ln.startsWith("---"))
                              cls = "text-rose-600";
                            else if (ln.startsWith("@@")) cls = "text-orange-500";
                            return (
                              <div key={j} className={cls}>
                                {ln || " "}
                              </div>
                            );
                          })}
                      </pre>
                    </div>
                  </>
                ) : (
                  <p className="p-4 text-[12px] text-stone-400">Bir dosya seç.</p>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="py-3" />
      </section>
    </main>
  );
}
