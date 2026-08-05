"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { Logo, SLOGAN } from "../logo";
import { ThemeToggle } from "../ThemeToggle";
import { readNdjson } from "@/lib/streamChat";
import { downloadText } from "@/lib/download";
import { fileToDataUrl } from "@/lib/imageAttach";
import { type SectionSelection } from "@/lib/sectionPicker";

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
/** Sürüm geçmişi girdisi (git kontrol noktası ya da klon tabanı). */
type RepoVersion = { sha: string; short: string; message: string; at: number };
/** Sürüm farkı: içerik yok, yalnız diff (indirme gerekmez). */
type VerDiffFile = { path: string; status: RepoChange["status"]; diff?: string };

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

/** Bir mesaja iliştirilebilecek en fazla görsel sayısı. */
const MAX_IMAGES = 4;

/** Seçili stil proje başına saklanır — sohbete girince en son seçilen geri gelir. */
const STYLE_KEY = (id: string) => `rukible_style_v1_${id}`;

/**
 * Panoya kopyalar. Ofiste araç http://<ip> üzerinden açılıyor ve güvensiz
 * bağlamda (https değil) navigator.clipboard tanımsız — o yüzden eski
 * execCommand yöntemine düşülür.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

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

/** Unix saniyeyi "3 dk önce" gibi kısa göreli metne çevirir (server saatinden). */
function agoLabel(at: number, nowMs: number): string {
  if (!at) return "";
  const s = Math.max(0, Math.floor(nowMs / 1000 - at));
  if (s < 60) return "az önce";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk önce`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} sa önce`;
  const d = Math.floor(h / 24);
  return `${d} gün önce`;
}

/** Diff metnini renkli satırlara böler (Değişenler ve Sürümler'de ortak). */
function DiffBody({ diff }: { diff: string }) {
  return (
    <pre className="text-[12px] leading-relaxed">
      {diff.split("\n").map((ln, j) => {
        let cls = "text-stone-500";
        if (ln.startsWith("+") && !ln.startsWith("+++")) cls = "text-emerald-600";
        else if (ln.startsWith("-") && !ln.startsWith("---")) cls = "text-rose-600";
        else if (ln.startsWith("@@")) cls = "text-orange-500";
        return (
          <div key={j} className={cls}>
            {ln || " "}
          </div>
        );
      })}
    </pre>
  );
}

/** Bir dev-log satırının rengini içeriğine göre seçer (koyu konsol üstünde). */
function logLineClass(l: string): string {
  if (/(^|[\s✗×])(error|failed|exception|cannot|hata|ENOENT|EADDRINUSE)\b/i.test(l))
    return "text-rose-300";
  if (/\b(warn|warning|deprecat|uyar)/i.test(l)) return "text-amber-300";
  if (/(^|\s)(✓|ready|compiled|success|hazır|listening|started)\b/i.test(l))
    return "text-emerald-300";
  if (/^\s*\$ /.test(l)) return "text-sky-300";
  return "text-[#d7d2e0]";
}

/** Bir dev satırı hata/uyarı işareti taşıyor mu (nokta göstergesi için). */
function isErrorLog(l: string): boolean {
  return /(^|[\s✗×])(error|failed|exception|cannot|hata|ENOENT|EADDRINUSE)\b/i.test(l);
}

/** Renkli dev-log gövdesi (kurulum/hata ekranları + canlı panel ortak kullanır). */
function DevLogLines({ logs }: { logs: string[] }) {
  if (logs.length === 0) return <span className="text-stone-500">Log yok…</span>;
  return (
    <>
      {logs.map((l, i) => (
        <div key={i} className={logLineClass(l)}>
          {l || " "}
        </div>
      ))}
    </>
  );
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
  // Sıradaki mesaja iliştirilecek görseller (ekran görüntüsü / projeye eklenecek
  // foto) — data URL. Orijinal dosya küçükse format bozulmadan taşınır ki ajan
  // save_image ile projeye birebir kaydedebilsin.
  const [pendingImages, setPendingImages] = useState<string[]>([]);

  const [tab, setTab] = useState<
    "preview" | "changes" | "files" | "versions"
  >("preview");

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
  /** Önizleme genişliği: mobil (dar) mı masaüstü (tam) mü. */
  const [mobileView, setMobileView] = useState(false);
  /** Bölüm seçme modu: açıkken önizlemede tıklanan bölüm seçilir. */
  const [pickMode, setPickMode] = useState(false);
  const [selection, setSelection] = useState<SectionSelection | null>(null);
  /** "Linki kopyala" geri bildirimi (kopyalandıktan sonra kısa süre ✓). */
  const [linkCopied, setLinkCopied] = useState(false);

  // Çatı önizlemesi (dev sunucusu)
  const [devStatus, setDevStatus] = useState<
    "idle" | "installing" | "starting" | "ready" | "error" | "stopped"
  >("idle");
  const [devPort, setDevPort] = useState<number | null>(null);
  // Önizleme iframe'inin bağlandığı port (dev sunucusunun önündeki çerçeve
  // proxy'si — Firefox'taki sonsuz yenilenme döngüsünü önler).
  const [framePort, setFramePort] = useState<number | null>(null);
  // Paylaşım linki: sunucunun LAN IP'si + ofis ağına açık paylaşım proxy portu.
  // İkisi de sunucudan gelir — adres çubuğu localhost olsa bile link doğru olur.
  const [sharePort, setSharePort] = useState<number | null>(null);
  const [lanIp, setLanIp] = useState<string | null>(null);
  const [devLogs, setDevLogs] = useState<string[]>([]);
  const [devError, setDevError] = useState("");
  // Log paneli açık mı (ready iken iframe'in altında dock). Kopyalama ✓'i ayrı.
  const [showLogs, setShowLogs] = useState(false);
  const [logsCopied, setLogsCopied] = useState(false);
  const logBoxRef = useRef<HTMLPreElement>(null);
  const devPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [changes, setChanges] = useState<RepoChange[]>([]);
  const [selected, setSelected] = useState(0);

  // Commit & Push (Değişenler sekmesi)
  const [pushMsg, setPushMsg] = useState("");
  const [pushBranch, setPushBranch] = useState("");
  const [pushBusy, setPushBusy] = useState(false);
  const [pushNote, setPushNote] = useState<{
    tone: "ok" | "err";
    text: string;
    prUrl?: string | null;
  } | null>(null);

  // Sürüm geçmişi (Sürümler sekmesi). Her ajan turu bir "sürüm" (git kontrol
  // noktası); taban = klonun ilk hâli. Geri alma yıkıcı değil (yeni sürüm).
  const [versions, setVersions] = useState<RepoVersion[]>([]);
  const [baseVersion, setBaseVersion] = useState<RepoVersion | null>(null);
  const [headSha, setHeadSha] = useState("");
  const [confirmRevert, setConfirmRevert] = useState<string | null>(null);
  const [revertBusy, setRevertBusy] = useState<string | null>(null);
  // Karşılaştırma: iki sürüm seçilince arasındaki fark gösterilir.
  const [compareMode, setCompareMode] = useState(false);
  const [cmpA, setCmpA] = useState<string | null>(null);
  const [cmpB, setCmpB] = useState<string | null>(null);
  const [verDiff, setVerDiff] = useState<VerDiffFile[] | null>(null);
  const [verDiffBusy, setVerDiffBusy] = useState(false);
  const [verSelected, setVerSelected] = useState(0);
  const [verActive, setVerActive] = useState<string | null>(null);
  // Göreli zaman etiketleri için "şimdi". Sunucuda 0 (sürüm listesi boş, DOM'a
  // düşmez); istemcide gerçek saat. Dakikada bir tazelenir (aşağıdaki effect).
  const [nowMs, setNowMs] = useState<number>(() =>
    typeof window === "undefined" ? 0 : Date.now(),
  );

  // Boş durum (proje seçili değil): klonlama ekranı
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState("");
  const [projects, setProjects] = useState<RepoProject[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Varsayılan serbest; her proje kendi seçimini hatırlar (bkz. STYLE_KEY).
  const [style, setStyle] = useState("serbest");
  const [tokens, setTokens] = useState(0);
  const [usage, setUsage] = useState<{ kalan?: number; limit?: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLIFrameElement>(null);
  // Gönderim boyunca seçili bölümü taşır (state'i hemen temizleyip rozeti kaldırırız).
  const selectionRef = useRef<SectionSelection | null>(null);

  /** Yazdıkça çubuğu büyütür, belli bir yükseklikten sonra kendi içinde kaydırır. */
  function autoGrow() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }

  // Sol panel genişliği — ayraç sürüklenerek ayarlanır, localStorage'da saklanır.
  const [panelWidth, setPanelWidth] = useState(420);
  const draggingRef = useRef(false);

  /** Görsel(ler) seçildiğinde: data URL'e çevir, sıradaki mesaja iliştir. */
  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // aynı dosyaları tekrar seçebilmek için sıfırla
    if (files.length === 0) return;
    if (files.some((f) => !f.type.startsWith("image/"))) {
      setError("Sadece görsel (resim) eklenebilir.");
      return;
    }
    try {
      // 3 MB altı dosyalar olduğu gibi taşınır (şeffaf PNG bozulmasın);
      // daha büyükleri küçültülüp JPEG'e çevrilir.
      const urls = await Promise.all(
        files.map((f) => fileToDataUrl(f, { keepOriginalUnder: 3_000_000 })),
      );
      if (pendingImages.length + urls.length > MAX_IMAGES) {
        setError(`En fazla ${MAX_IMAGES} görsel eklenebilir.`);
      }
      setPendingImages((prev) => [...prev, ...urls].slice(0, MAX_IMAGES));
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

  const loadVersions = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/repo/versions?projectId=${id}`);
      if (!res.ok) return;
      const data = await res.json();
      setVersions(data.versions ?? []);
      setBaseVersion(data.base ?? null);
      setHeadSha(data.headSha ?? "");
    } catch {
      // yoksay
    }
  }, []);

  // Göreli zaman etiketlerini dakikada bir tazele (setState yalnız callback'te).
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Sürümler sekmesine girilince listeyi tazele (tembel yükleme).
  useEffect(() => {
    if (tab !== "versions" || !projectId) return;
    void (async () => {
      await loadVersions(projectId);
    })();
  }, [tab, projectId, loadVersions]);

  // Önizlemede seçilen bölümü dinle.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type !== "rukible:selected") return;
      const d = e.data as SectionSelection;
      setSelection({
        tag: d.tag,
        label: d.label,
        selector: d.selector,
        text: d.text,
        html: d.html,
      });
      // Seçim yapıldı: modu kapat, kullanıcı isteğini yazsın.
      setPickMode(false);
      previewRef.current?.contentWindow?.postMessage("rukible:pick:off", "*");
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Seç modunu önizlemeye ilet. Önizleme sekmesinden çıkınca da kapat.
  useEffect(() => {
    previewRef.current?.contentWindow?.postMessage(
      pickMode && tab === "preview" ? "rukible:pick:on" : "rukible:pick:off",
      "*",
    );
  }, [pickMode, tab]);

  // Log paneli açıkken CANLI takip: normal poll "ready"de duruyor (iframe aldı),
  // ama panel açıkken çalışma-anı loglarını ve olası çökmeyi (status→error)
  // görmek için 3 sn'de bir tazele. Yalnız panel açık + sunucu ayaktayken çalışır.
  useEffect(() => {
    if (!showLogs || !projectId) return;
    if (devStatus !== "ready" && devStatus !== "starting" && devStatus !== "installing")
      return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/repo/dev?projectId=${projectId}`);
        if (!r.ok || !alive) return;
        const d = await r.json();
        if (!alive) return;
        if (Array.isArray(d.logs)) setDevLogs(d.logs);
        if (d.status) setDevStatus(d.status);
        if (d.error) setDevError(d.error);
      } catch {
        // yoksay
      }
    };
    const iv = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [showLogs, projectId, devStatus]);

  // Yeni log geldikçe paneli en alta kaydır (setState yok — sadece DOM).
  useEffect(() => {
    if (showLogs && logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [devLogs, showLogs]);

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
        if (d.sharePort) setSharePort(d.sharePort);
        if (d.lanIp) setLanIp(d.lanIp);
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
        setSharePort(null);
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
        // Bu projede en son seçilen stil (yoksa serbest).
        setStyle(localStorage.getItem(STYLE_KEY(id)) ?? "serbest");
        await refreshChanges(id);
        // Zaten çalışan bir dev sunucusu varsa hemen benimse (eski/ölü porta
        // takılmadan doğru portu göster).
        try {
          const dev = await fetch(`/api/repo/dev?projectId=${id}`).then((r) =>
            r.ok ? r.json() : null,
          );
          if (dev?.lanIp) setLanIp(dev.lanIp);
          if (dev && dev.status === "ready" && dev.port) {
            setDevStatus("ready");
            setDevPort(dev.port);
            if (dev.framePort) setFramePort(dev.framePort);
            if (dev.sharePort) setSharePort(dev.sharePort);
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

  // Kayıtlı panel genişliğini geri yükle (/yeni'ninkinden ayrı anahtar).
  useEffect(() => {
    const saved = Number(localStorage.getItem("rukible_repo_panel"));
    if (saved >= 300 && saved <= 720) setPanelWidth(saved);
  }, []);

  // Ayırıcıyı sürükleme.
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!draggingRef.current) return;
      const w = Math.min(720, Math.max(300, e.clientX));
      setPanelWidth(w);
    }
    function onUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem("rukible_repo_panel", String(panelWidth));
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [panelWidth]);

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
      if (d.sharePort) setSharePort(d.sharePort);
      if (d.lanIp) setLanIp(d.lanIp);
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
    setSharePort(null);
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
    setPendingImages([]);
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
    imgs?: string[],
  ) {
    // Görsel varsa metin olmadan da gönderilebilir.
    if ((!text && !imgs?.length) || !projectId || streaming) return;

    // API'ye gerçek metni gönder; ekranda görselli boş mesajı "📷 Görsel" göster.
    const apiMessages = [...messages, { role: "user" as const, content: text }];
    const next: ChatMessage[] = [
      ...messages,
      { role: "user", content: text || "📷 Görsel", hasImage: !!imgs?.length },
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
          images: imgs?.length ? imgs : undefined,
          selection: selectionRef.current ?? undefined,
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

      // Sadece build modunda dosya değişir → önizlemeyi tazele + diff + sürüm.
      if (useMode === "build") {
        setPreviewKey((k) => k + 1);
        await refreshChanges(projectId);
        void loadVersions(projectId); // bu tur yeni bir sürüm (kontrol noktası)
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
      selectionRef.current = null; // seçim bu gönderimle tüketildi
    }
  }

  function send() {
    const text = input.trim();
    const imgs = pendingImages;
    if (!text && imgs.length === 0) return;
    // Seçili bölümü bu gönderim için sabitle, rozeti hemen temizle.
    selectionRef.current = selection;
    setSelection(null);
    setInput("");
    requestAnimationFrame(autoGrow); // gönderdikten sonra çubuk eski boyuna dönsün
    setPendingImages([]); // iliştirildi; kutuyu boşalt
    void runAgent(text, mode, imgs);
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
    setCloneError("");
    await fetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
    // Klon klasörünü diskten sil. Başarısız olursa (kilitli dosya vб.) sessiz
    // geçme — kullanıcı diskte artık kaldığını bilsin.
    const res = await fetch(`/api/repo/clone?projectId=${id}`, {
      method: "DELETE",
    }).catch(() => null);
    setProjects((prev) => prev.filter((p) => p.id !== id));
    if (!res || !res.ok) {
      setCloneError(
        "Proje listeden kaldırıldı ama klon klasörü diskten tam silinemedi. " +
          "Önizleme çalışıyorsa durdurup tekrar sil.",
      );
    }
  }

  function applyPlan(planText: string) {
    void runAgent(`Şu planı uygula:\n\n${planText}`, "build");
  }

  /** Değişiklikleri tek commit yapıp origin'e push'lar (bkz. api/repo/push). */
  async function commitPush() {
    if (!projectId || pushBusy || changes.length === 0) return;
    setPushBusy(true);
    setPushNote(null);
    try {
      const res = await fetch("/api/repo/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          message: pushMsg.trim() || undefined,
          branch: pushBranch.trim() || undefined,
        }),
      });
      if (!res.ok) {
        setPushNote({ tone: "err", text: await res.text() });
        return;
      }
      const d = await res.json();
      setPushNote({
        tone: "ok",
        text: d.direct
          ? `${d.branch} dalına push'landı (${d.sha}).`
          : `Yeni "${d.branch}" dalına push'landı (${d.sha}).`,
        prUrl: d.prUrl,
      });
      setPushMsg("");
      // Push, artakalan elle düzenlemeleri bir sürüme katlayabilir → tazele.
      await refreshChanges(projectId);
      void loadVersions(projectId);
    } catch (e) {
      setPushNote({ tone: "err", text: (e as Error).message ?? "Push başarısız." });
    } finally {
      setPushBusy(false);
    }
  }

  /** İki sürüm arasındaki farkı getirir (from→to; to yoksa HEAD). */
  async function loadVersionDiff(from: string, to: string) {
    if (!projectId) return;
    setVerDiffBusy(true);
    setVerSelected(0);
    try {
      const res = await fetch(
        `/api/repo/versions?projectId=${projectId}&from=${from}&to=${to}`,
      );
      if (!res.ok) {
        setVerDiff([]);
        return;
      }
      const data = await res.json();
      setVerDiff(data.files ?? []);
    } catch {
      setVerDiff([]);
    } finally {
      setVerDiffBusy(false);
    }
  }

  /** Bir sürüme döner (yıkıcı değil: yeni kontrol noktası). Sonra tazeler. */
  async function revertTo(sha: string) {
    if (!projectId || revertBusy) return;
    setRevertBusy(sha);
    setConfirmRevert(null);
    setError("");
    try {
      const res = await fetch("/api/repo/versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, sha }),
      });
      if (!res.ok) {
        setError(await res.text());
        return;
      }
      setVerDiff(null);
      setVerActive(null);
      setCompareMode(false);
      setCmpA(null);
      setCmpB(null);
      setPreviewKey((k) => k + 1);
      await Promise.all([loadVersions(projectId), refreshChanges(projectId)]);
    } catch (e) {
      setError((e as Error).message ?? "Geri alınamadı.");
    } finally {
      setRevertBusy(null);
    }
  }

  // ---------- BOŞ DURUM: klonlama ekranı ----------
  if (!projectId) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#fff7f3] px-6 text-stone-700">
        <ThemeToggle className="fixed right-5 top-5 grid h-9 w-9 place-items-center rounded-full bg-white text-[16px] shadow-[0_1px_3px_rgba(120,80,60,0.12)] transition hover:bg-orange-50" />
        <div className="w-full max-w-[440px]">
          <div className="mb-8 flex flex-col items-center text-center">
            <Logo size={92} href="/" />
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
              className="mt-2 w-full rounded-xl bg-orange-400 py-2.5 text-[13px] font-medium text-[#fff] transition hover:bg-orange-500 disabled:bg-stone-100 disabled:text-stone-300"
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

          <div className="mt-6 flex justify-center">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2 text-[12.5px] font-medium text-stone-600 shadow-[0_1px_2px_rgba(120,80,60,0.06)] transition hover:bg-orange-50 hover:text-orange-500"
            >
              <span aria-hidden="true">←</span> Ana sayfa
            </Link>
          </div>
        </div>
      </main>
    );
  }

  // ---------- ÇALIŞMA ALANI ----------
  const selectedChange = changes[selected];

  // Sürüm listesi (yeni → eski) + en altta klon tabanı. Numara: en yeni en
  // büyük (v3, v2, v1, Başlangıç). Her satırın "ebeveyni" bir sonraki (daha
  // eski) sürüm — o sürümün GETİRDİĞİ farkı göstermek için.
  const allVersions: {
    v: RepoVersion;
    label: string;
    isBase: boolean;
    isHead: boolean;
    parentSha: string | null;
  }[] = [
    ...versions.map((v, i) => ({
      v,
      label: `v${versions.length - i}`,
      isBase: false,
      isHead: v.sha === headSha,
      parentSha:
        i < versions.length - 1 ? versions[i + 1].sha : baseVersion?.sha ?? null,
    })),
    ...(baseVersion
      ? [
          {
            v: baseVersion,
            label: "Başlangıç",
            isBase: true,
            isHead: baseVersion.sha === headSha,
            parentSha: null,
          },
        ]
      : []),
  ];
  const verSelectedFile = verDiff?.[verSelected];

  /** Karşılaştırma modunda A/B seçer; ikisi de dolunca farkı yükler. */
  function pickCompare(sha: string) {
    let a = cmpA;
    let b = cmpB;
    if (a === sha) {
      setCmpA(null);
      setVerDiff(null);
      return;
    }
    if (b === sha) {
      setCmpB(null);
      setVerDiff(null);
      return;
    }
    if (!a) {
      setCmpA(sha);
      a = sha;
    } else if (!b) {
      setCmpB(sha);
      b = sha;
    } else {
      // ikisi de doluyken üçüncü seçim → yeni karşılaştırma başlat
      setCmpA(sha);
      setCmpB(null);
      setVerDiff(null);
      return;
    }
    if (a && b) {
      const idx = (s: string) => allVersions.findIndex((e) => e.v.sha === s);
      // büyük index = daha eski = farkın "from"u.
      const [from, to] = idx(a) > idx(b) ? [a, b] : [b, a];
      void loadVersionDiff(from, to);
    }
  }

  /** Bir sürüme tıklayınca: karşılaştırmada A/B; normalde o sürümün farkı. */
  function selectVersion(entry: (typeof allVersions)[number]) {
    if (compareMode) {
      pickCompare(entry.v.sha);
      return;
    }
    setVerActive(entry.v.sha);
    if (!entry.parentSha) {
      setVerDiff([]); // taban: klonun ilk hâli, öncesi yok
      return;
    }
    void loadVersionDiff(entry.parentSha, entry.v.sha);
  }
  const devFw = detectFramework(tree);
  // Loglarda hata/uyarı işareti var mı → "Loglar" düğmesinde kırmızı nokta.
  const logHasError = devLogs.some(isErrorLog);
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

  // Başkasına atılacak önizleme linki. Adres çubuğu localhost olsa bile doğru
  // olsun diye makine adı sunucudan gelen LAN IP'siyle kurulur.
  //  - Çatı projesi: ofis ağına açık paylaşım proxy'si (native çalışır; canlı
  //    önizleme proxy'sinin aksine sayfanın JS'i/animasyonları bozulmaz).
  //  - Statik proje: Rukible'ın statik önizleme rotası.
  const shareHost =
    lanIp ?? (typeof window !== "undefined" ? window.location.hostname : "");
  const shareUrl =
    projectId && typeof window !== "undefined" && shareHost
      ? previewPath && hasStaticEntry(tree)
        ? `http://${shareHost}${window.location.port ? `:${window.location.port}` : ""}/api/preview/${projectId}/${previewPath}`
        : devStatus === "ready" && sharePort
          ? `http://${shareHost}:${sharePort}`
          : ""
      : "";

  // Önizleme iframe'i şu an gerçekten görünüyor mu (statik giriş ya da hazır dev
  // sunucusu). Sadece o zaman Masaüstü/Mobil geçişini göstermek anlamlı.
  const previewLive = Boolean(
    (previewPath && hasStaticEntry(tree)) || (devStatus === "ready" && devPort),
  );

  return (
    <main className="flex h-screen bg-[#fff7f3] text-stone-700">
      {/* SOL — sohbet */}
      <section style={{ width: panelWidth }} className="flex shrink-0 flex-col overflow-hidden">
        <header className="px-7 py-6">
          <div className="flex items-center gap-3">
            {/* Logo artık ana sayfa bağlantısı — ayrı "Başa dön" tuşuna gerek yok. */}
            <Logo size={38} href="/" />
            <div className="min-w-0 flex-1 leading-none">
              <div className="truncate text-[17px] font-semibold tracking-tight text-stone-800">
                {title || "Proje"}
              </div>
              <div className="mt-1 truncate text-[11px] text-stone-400">{repoUrl}</div>
            </div>
            <ThemeToggle className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white text-[15px] shadow-[0_1px_2px_rgba(120,80,60,0.06)] transition hover:bg-orange-50" />
          </div>

          {/* Hafif metin eylemleri (eski dört pil yerine): proje listesine dön +
              yeniden klonla. Logo zaten ana sayfaya götürüyor. */}
          <div className="mt-4 flex items-center gap-3 text-[12px]">
            <button
              onClick={() => {
                clearDevPoll();
                setDevStatus("idle");
                setDevPort(null);
                setFramePort(null);
                setSharePort(null);
                resetEditor();
                setProjectId(null);
                setMessages([]);
                loadProjects();
              }}
              className="group flex items-center gap-1 font-medium text-stone-600 transition hover:text-orange-500"
            >
              <span aria-hidden="true" className="transition group-hover:-translate-x-0.5">
                ‹
              </span>
              Projeler
            </button>
            <span className="text-stone-300" aria-hidden="true">
              ·
            </span>
            <button
              onClick={reclone}
              disabled={cloning || streaming}
              title="Repoyu yeniden klonla (yerel değişiklikleri sıfırlar)"
              className="flex items-center gap-1 text-stone-400 transition hover:text-stone-700 disabled:opacity-40"
            >
              <span aria-hidden="true">↻</span> Yeniden klonla
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
                  className="mt-3 rounded-lg bg-orange-400 px-3.5 py-1.5 text-[12px] font-medium text-[#fff] transition hover:bg-orange-500 disabled:opacity-40"
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
                      ? "bg-orange-400 text-[#fff]"
                      : "text-stone-400 hover:text-stone-600"
                  }`}
                >
                  Build
                </button>
                <button
                  onClick={() => setMode("plan")}
                  className={`rounded-full px-3 py-1 transition ${
                    mode === "plan"
                      ? "bg-orange-400 text-[#fff]"
                      : "text-stone-400 hover:text-stone-600"
                  }`}
                >
                  Plan
                </button>
              </div>
              <select
                value={style}
                onChange={(e) => {
                  setStyle(e.target.value);
                  if (projectId) localStorage.setItem(STYLE_KEY(projectId), e.target.value);
                }}
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
                title="Görsel ekle (birden fazla seçilebilir) — ekran görüntüsü ya da projeye eklenecek foto"
                className="rounded-full px-2 py-1 text-[13px] text-stone-400 transition hover:bg-orange-100 hover:text-stone-700"
              >
                📎
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleFile}
                className="hidden"
              />
            </div>
            <span className="shrink-0 text-[11px] tabular-nums text-stone-400">
              {usage?.kalan != null && (
                <span
                  className={
                    usage.kalan < 1 ? "font-medium text-rose-600" : "text-stone-500"
                  }
                >
                  Kalan ${usage.kalan.toFixed(2)}
                </span>
              )}
              {(() => {
                // Kalan bakiye yoksa (ör. Qwen) sadece harcananı göster — baştaki
                // " · " sarkmasın diye parçaları temiz birleştir.
                const parts = [
                  cost > 0 ? `bu oturum $${cost.toFixed(4)}` : null,
                  tokens > 0 ? `${tokens.toLocaleString("tr-TR")} token` : null,
                ].filter(Boolean);
                if (parts.length === 0) return null;
                return (usage?.kalan != null ? " · " : "") + parts.join(" · ");
              })()}
            </span>
          </div>
          <div className="rounded-2xl bg-white p-2 shadow-[0_1px_3px_rgba(120,80,60,0.08)]">
            {/* İliştirilen görsel önizlemeleri */}
            {pendingImages.length > 0 && (
              <div className="mb-1 flex flex-wrap items-center gap-2 px-1">
                {pendingImages.map((src, i) => (
                  <div key={i} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={src}
                      alt={`eklenen görsel ${i + 1}`}
                      className="h-12 w-12 rounded-lg object-cover ring-1 ring-orange-200"
                    />
                    <button
                      onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                      title="Görseli kaldır"
                      className="absolute -right-1.5 -top-1.5 rounded-full bg-white px-1 text-[11px] leading-4 text-stone-400 shadow ring-1 ring-stone-200 transition hover:text-rose-600"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <span className="text-[11.5px] text-stone-500">
                  {pendingImages.length > 1
                    ? `${pendingImages.length} görsel eklendi`
                    : "Görsel eklendi"}
                </span>
              </div>
            )}
            {selection && (
              <div className="mb-1 flex items-center gap-2 rounded-xl bg-orange-100/70 px-2.5 py-1.5">
                <span className="text-[12px]">🎯</span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-stone-600">
                  Seçili: <span className="font-medium">{selection.label}</span>
                  {selection.text ? ` · "${selection.text.slice(0, 40)}"` : ""}
                </span>
                <button
                  onClick={() => setSelection(null)}
                  title="Seçimi temizle (tüm sayfaya uygula)"
                  className="shrink-0 rounded px-1 text-[13px] leading-none text-stone-400 transition hover:text-rose-600"
                >
                  ×
                </button>
              </div>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autoGrow();
              }}
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
                disabled={!input.trim() && pendingImages.length === 0}
                className="w-full rounded-2xl bg-orange-400 py-2.5 text-[13px] font-medium text-[#fff] transition hover:bg-orange-500 disabled:bg-stone-100 disabled:text-stone-300"
              >
                {mode === "plan" ? "Planla" : "Gönder"}
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Ayırıcı — sürükleyerek genişlik ayarlanır */}
      <div
        onMouseDown={() => {
          draggingRef.current = true;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        title="Sürükleyerek genişliği ayarla"
        className="group relative w-1.5 shrink-0 cursor-col-resize"
      >
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-stone-200 transition group-hover:w-0.5 group-hover:bg-orange-300" />
      </div>

      {/* SAĞ — önizleme / değişenler */}
      <section className="flex min-w-0 flex-1 flex-col pr-4">
        <header className="flex items-center justify-between gap-4 py-6 pl-2 pr-4">
          <div className="flex gap-1 rounded-full bg-white/70 p-1 text-xs">
            <button
              onClick={() => setTab("preview")}
              className={`rounded-full px-3 py-1 transition ${
                tab === "preview"
                  ? "bg-orange-400 text-[#fff]"
                  : "text-stone-400 hover:text-stone-600"
              }`}
            >
              Önizleme
            </button>
            <button
              onClick={() => setTab("files")}
              className={`rounded-full px-3 py-1 transition ${
                tab === "files"
                  ? "bg-orange-400 text-[#fff]"
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
                  ? "bg-orange-400 text-[#fff]"
                  : "text-stone-400 hover:text-stone-600"
              }`}
            >
              Değişenler{changes.length > 0 ? ` (${changes.length})` : ""}
            </button>
            <button
              onClick={() => setTab("versions")}
              className={`rounded-full px-3 py-1 transition ${
                tab === "versions"
                  ? "bg-orange-400 text-[#fff]"
                  : "text-stone-400 hover:text-stone-600"
              }`}
            >
              Sürümler{versions.length > 0 ? ` (${versions.length})` : ""}
            </button>
          </div>
          {tab === "preview" && (
            <div className="flex items-center gap-2">
              {previewLive && (
                <div className="flex gap-1 rounded-full bg-white/70 p-1 text-xs">
                  <button
                    onClick={() => setMobileView(false)}
                    className={`rounded-full px-3 py-1 transition ${
                      !mobileView
                        ? "bg-orange-400 text-[#fff]"
                        : "text-stone-400 hover:text-stone-600"
                    }`}
                  >
                    Masaüstü
                  </button>
                  <button
                    onClick={() => setMobileView(true)}
                    className={`rounded-full px-3 py-1 transition ${
                      mobileView
                        ? "bg-orange-400 text-[#fff]"
                        : "text-stone-400 hover:text-stone-600"
                    }`}
                  >
                    Mobil
                  </button>
                </div>
              )}
              {previewLive && (
                <button
                  onClick={() => setPickMode((v) => !v)}
                  title="Bir bölüm seç; sonraki istek yalnız o bölüme uygulanır"
                  className={`rounded-xl px-3 py-1.5 text-[12.5px] font-medium transition ${
                    pickMode
                      ? "bg-orange-400 text-[#fff] hover:bg-orange-500"
                      : "bg-white text-stone-600 shadow-[0_1px_2px_rgba(120,80,60,0.06)] hover:bg-orange-50"
                  }`}
                >
                  {pickMode ? "🎯 Seçiliyor…" : "🎯 Seç"}
                </button>
              )}
              {shareUrl && (
                <button
                  onClick={async () => {
                    const ok = await copyText(shareUrl);
                    setLinkCopied(ok);
                    if (ok) setTimeout(() => setLinkCopied(false), 2000);
                  }}
                  title="Önizleme linkini kopyala — aynı ağdaki herkes açabilir"
                  className="rounded-xl bg-white px-3 py-1.5 text-[12.5px] font-medium text-stone-600 shadow-[0_1px_2px_rgba(120,80,60,0.06)] transition hover:bg-orange-50"
                >
                  {linkCopied ? "Kopyalandı ✓" : "🔗 Linki kopyala"}
                </button>
              )}
              <button
                onClick={() => setPreviewKey((k) => k + 1)}
                className="rounded-xl bg-white px-3 py-1.5 text-[12.5px] font-medium text-stone-600 shadow-[0_1px_2px_rgba(120,80,60,0.06)] transition hover:bg-orange-50"
              >
                Yenile
              </button>
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-hidden rounded-2xl bg-white shadow-[0_1px_3px_rgba(120,80,60,0.08)]">
          {tab === "preview" ? (
            previewPath && hasStaticEntry(tree) ? (
              <div
                className={`flex h-full ${
                  mobileView ? "justify-center overflow-auto bg-stone-100/60 p-4" : ""
                }`}
              >
                <iframe
                  key={previewKey}
                  ref={previewRef}
                  src={`/api/preview/${projectId}/${previewPath}`}
                  sandbox="allow-scripts allow-forms allow-popups"
                  onLoad={() => {
                    if (pickMode)
                      previewRef.current?.contentWindow?.postMessage(
                        "rukible:pick:on",
                        "*",
                      );
                  }}
                  className={`border-0 transition-all ${
                    mobileView
                      ? "h-full w-[390px] shrink-0 rounded-2xl shadow-[0_2px_16px_rgba(120,80,60,0.12)]"
                      : "h-full w-full"
                  }`}
                  title="Önizleme"
                />
              </div>
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
                      <button
                        onClick={() => setShowLogs((v) => !v)}
                        title="Dev sunucusu loglarını göster/gizle"
                        className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11.5px] transition ${
                          showLogs
                            ? "bg-orange-400 text-[#fff] hover:bg-orange-500"
                            : "bg-white text-stone-600 hover:bg-orange-50"
                        }`}
                      >
                        Loglar
                        {logHasError && !showLogs && (
                          <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                        )}
                      </button>
                    )}
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
                        className="rounded-lg bg-orange-400 px-2.5 py-1 text-[11.5px] font-medium text-[#fff] transition hover:bg-orange-500"
                      >
                        ▸ Önizlemeyi başlat
                      </button>
                    )}
                  </span>
                </div>

                {/* gövde */}
                {devStatus === "ready" && devPort ? (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <div
                      className={`flex min-h-0 flex-1 ${
                        mobileView
                          ? "justify-center overflow-auto bg-stone-100/60 p-4"
                          : ""
                      }`}
                    >
                      <iframe
                        key={previewKey}
                        ref={previewRef}
                        src={previewSrc}
                        onLoad={() => {
                          if (pickMode)
                            previewRef.current?.contentWindow?.postMessage(
                              "rukible:pick:on",
                              "*",
                            );
                        }}
                        className={`min-h-0 border-0 transition-all ${
                          mobileView
                            ? "h-full w-[390px] shrink-0 rounded-2xl shadow-[0_2px_16px_rgba(120,80,60,0.12)]"
                            : "w-full flex-1"
                        }`}
                        title="Önizleme"
                      />
                    </div>

                    {/* Canlı log dock'u (iframe'in altında; çalışırken patlarsa
                        neden patladığını burada görürsün). */}
                    {showLogs && (
                      <div className="flex h-56 shrink-0 flex-col border-t border-stone-200">
                        <div className="flex items-center justify-between gap-2 bg-[#0d0a16]/95 px-3 py-1.5">
                          <span className="flex items-center gap-2 text-[11.5px] text-[#b3a8c9]">
                            Dev sunucusu logları
                            {logHasError && (
                              <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] text-rose-300">
                                hata var
                              </span>
                            )}
                            <span className="text-[10px] text-[#6a5a8a]">
                              · canlı
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <button
                              onClick={async () => {
                                const ok = await copyText(devLogs.join("\n"));
                                setLogsCopied(ok);
                                if (ok) setTimeout(() => setLogsCopied(false), 2000);
                              }}
                              className="rounded bg-white/10 px-2 py-0.5 text-[11px] text-[#d7d2e0] transition hover:bg-white/20"
                            >
                              {logsCopied ? "Kopyalandı ✓" : "Kopyala"}
                            </button>
                            <button
                              onClick={() => setShowLogs(false)}
                              title="Log panelini kapat"
                              className="rounded px-1.5 text-[13px] leading-none text-[#9a8fb2] transition hover:text-[#e7e1f3]"
                            >
                              ×
                            </button>
                          </span>
                        </div>
                        <pre
                          ref={logBoxRef}
                          className="min-h-0 flex-1 overflow-auto bg-[#0d0a16]/95 px-3 pb-3 text-[11px] leading-relaxed"
                        >
                          <DevLogLines logs={devLogs} />
                        </pre>
                      </div>
                    )}
                  </div>
                ) : devStatus === "installing" || devStatus === "starting" ? (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <p className="px-4 pt-3 text-[13px] text-stone-500">
                      {devStatus === "installing"
                        ? "Projenin bağımlılıkları kuruluyor (ilk seferde birkaç dakika sürebilir)…"
                        : "Dev sunucusu başlatılıyor, hazır olunca site burada görünecek…"}
                    </p>
                    <pre className="mx-4 mb-4 mt-2 min-h-0 flex-1 overflow-auto rounded-lg bg-[#0d0a16]/95 p-3 text-[11px] leading-relaxed">
                      <DevLogLines logs={devLogs} />
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
                        className="mt-4 rounded-xl bg-orange-400 px-4 py-2 text-[13px] font-medium text-[#fff] transition hover:bg-orange-500"
                      >
                        ▸ Önizlemeyi başlat
                      </button>
                      {devError && (
                        <p className="mt-3 text-[12px] text-rose-600">{devError}</p>
                      )}
                      {devLogs.length > 0 && (
                        <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-[#0d0a16]/95 p-3 text-left text-[11px] leading-relaxed">
                          <DevLogLines logs={devLogs} />
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
                          className="rounded-lg bg-orange-400 px-2.5 py-1 text-[11.5px] font-medium text-[#fff] transition hover:bg-orange-500 disabled:opacity-40"
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
                      className="min-h-0 flex-1 resize-none bg-[#0d0a16]/95 p-3 font-[family-name:var(--font-mono)] text-[12px] leading-relaxed text-[#f5f5f4] outline-none"
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
          ) : tab === "changes" ? (
            <div className="flex h-full flex-col">
              {/* Commit & Push çubuğu */}
              <div className="flex items-center gap-2 border-b border-stone-100 px-3 py-2">
                <input
                  value={pushMsg}
                  onChange={(e) => setPushMsg(e.target.value)}
                  placeholder="Commit mesajı (örn. iletişim bölümü koyulaştırıldı)"
                  className="min-w-0 flex-1 rounded-lg bg-stone-50 px-2.5 py-1.5 text-[12px] outline-none ring-1 ring-stone-200 focus:ring-orange-300"
                />
                <input
                  value={pushBranch}
                  onChange={(e) => setPushBranch(e.target.value)}
                  placeholder="dal (boş: rukible/tarih)"
                  title="Push'lanacak dal. Boş bırakılırsa yeni bir rukible/tarih dalı açılır; mevcut dala (örn. main) doğrudan göndermek için adını yaz."
                  className="w-44 shrink-0 rounded-lg bg-stone-50 px-2.5 py-1.5 text-[12px] outline-none ring-1 ring-stone-200 focus:ring-orange-300"
                />
                <button
                  onClick={commitPush}
                  disabled={pushBusy || streaming || changes.length === 0}
                  className="shrink-0 rounded-lg bg-orange-400 px-3 py-1.5 text-[12px] font-medium text-[#fff] transition hover:bg-orange-500 disabled:opacity-40"
                >
                  {pushBusy ? "Gönderiliyor…" : "Commit & Push"}
                </button>
              </div>
              {pushNote && (
                <p
                  className={`border-b px-3 py-2 text-[12px] ${
                    pushNote.tone === "ok"
                      ? "border-emerald-100 bg-emerald-50 text-emerald-700"
                      : "border-rose-100 bg-rose-50 text-rose-600"
                  }`}
                >
                  {pushNote.tone === "ok" && <span aria-hidden="true">✓ </span>}
                  <span className="whitespace-pre-line">{pushNote.text}</span>
                  {pushNote.prUrl && (
                    <>
                      {" "}
                      <a
                        href={pushNote.prUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium underline hover:text-emerald-900"
                      >
                        PR aç ↗
                      </a>
                    </>
                  )}
                </p>
              )}

              <div className="flex min-h-0 flex-1">
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
                      <DiffBody diff={selectedChange.diff || "(fark gösterilemiyor)"} />
                    </div>
                  </>
                ) : (
                  <p className="p-4 text-[12px] text-stone-400">Bir dosya seç.</p>
                )}
              </div>
              </div>
            </div>
          ) : (
            /* SÜRÜMLER: her ajan turu bir git kontrol noktası. Geri al (yıkıcı
               değil, yeni sürüm) + iki sürüm arası fark. */
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between gap-2 border-b border-stone-100 px-3 py-2">
                <span className="text-[12px] text-stone-500">
                  Sürüm geçmişi
                  {allVersions.length ? ` · ${allVersions.length} kayıt` : ""}
                </span>
                <button
                  onClick={() => {
                    setCompareMode((v) => !v);
                    setCmpA(null);
                    setCmpB(null);
                    setVerActive(null);
                    setVerDiff(null);
                  }}
                  className={`rounded-lg px-2.5 py-1 text-[11.5px] transition ${
                    compareMode
                      ? "bg-orange-400 text-[#fff]"
                      : "bg-white text-stone-600 hover:bg-orange-50"
                  }`}
                >
                  {compareMode ? "Karşılaştırmayı kapat" : "⇄ Karşılaştır"}
                </button>
              </div>
              {compareMode && (
                <p className="border-b border-stone-100 bg-orange-50/40 px-3 py-1.5 text-[11.5px] text-stone-500">
                  İki sürüm seç · A {cmpA ? "✓" : "—"} · B {cmpB ? "✓" : "—"}
                </p>
              )}

              <div className="flex min-h-0 flex-1">
                {/* sürüm listesi */}
                <div className="w-72 shrink-0 overflow-y-auto border-r border-stone-100 p-2">
                  {allVersions.length === 0 && (
                    <p className="p-2 text-[12px] text-stone-400">
                      Henüz sürüm yok. Sohbetle bir değişiklik yap; her tur bir
                      sürüm olarak buraya düşer.
                    </p>
                  )}
                  <div className="space-y-1">
                    {allVersions.map((entry) => {
                      const sha = entry.v.sha;
                      const pickLabel =
                        cmpA === sha ? "A" : cmpB === sha ? "B" : "";
                      const highlight = compareMode
                        ? !!pickLabel
                        : verActive === sha;
                      return (
                        <div
                          key={sha}
                          className={`rounded-lg px-2 py-1.5 transition ${
                            highlight
                              ? "bg-orange-100 ring-1 ring-orange-300"
                              : "hover:bg-orange-50"
                          }`}
                        >
                          <button
                            onClick={() => selectVersion(entry)}
                            className="block w-full text-left"
                            title={entry.v.message}
                          >
                            <div className="flex items-center gap-1.5">
                              <span className="text-[12px] font-medium text-stone-700">
                                {entry.label}
                              </span>
                              {entry.isHead && (
                                <span className="rounded bg-emerald-100 px-1 text-[10px] text-emerald-700">
                                  ● şu an
                                </span>
                              )}
                              {pickLabel && (
                                <span className="rounded bg-orange-400 px-1 text-[10px] text-[#fff]">
                                  {pickLabel}
                                </span>
                              )}
                              <span className="ml-auto shrink-0 text-[10.5px] text-stone-400">
                                {agoLabel(entry.v.at, nowMs)}
                              </span>
                            </div>
                            <p className="mt-0.5 truncate text-[11.5px] text-stone-500">
                              {entry.isBase
                                ? "Klonun ilk hâli"
                                : entry.v.message || "(mesaj yok)"}
                            </p>
                          </button>

                          {!entry.isHead &&
                            !compareMode &&
                            (confirmRevert === sha ? (
                              <div className="mt-1 flex items-center gap-1 text-[11px]">
                                <span className="text-stone-500">
                                  Bu sürüme dönülsün mü?
                                </span>
                                <button
                                  onClick={() => revertTo(sha)}
                                  disabled={revertBusy != null}
                                  className="rounded bg-orange-400 px-1.5 py-0.5 font-medium text-[#fff] transition hover:bg-orange-500 disabled:opacity-40"
                                >
                                  {revertBusy === sha ? "…" : "dön"}
                                </button>
                                <button
                                  onClick={() => setConfirmRevert(null)}
                                  className="rounded px-1.5 py-0.5 text-stone-500 transition hover:text-stone-800"
                                >
                                  vazgeç
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setConfirmRevert(sha)}
                                className="mt-1 text-[11px] text-stone-400 transition hover:text-orange-500"
                              >
                                ↩ Bu sürüme dön
                              </button>
                            ))}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* fark paneli */}
                <div className="flex min-w-0 flex-1 flex-col">
                  {verDiffBusy ? (
                    <p className="p-4 text-[12px] text-stone-400">
                      Fark hesaplanıyor…
                    </p>
                  ) : verDiff === null ? (
                    <div className="grid h-full place-items-center px-6 text-center">
                      <p className="max-w-[280px] text-[12px] leading-relaxed text-stone-400">
                        {compareMode
                          ? "İki sürüm seç; aralarındaki fark burada görünür."
                          : "Soldan bir sürüm seç; o turda ne değiştiğini burada göster. “↩ Bu sürüme dön” ile o hâle geri dönebilirsin."}
                      </p>
                    </div>
                  ) : verDiff.length === 0 ? (
                    <p className="p-4 text-[12px] text-stone-400">
                      Bu iki sürüm arasında fark yok.
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-1 border-b border-stone-100 p-2">
                        {verDiff.map((f, i) => {
                          const chip = statusChip(f.status);
                          return (
                            <button
                              key={f.path}
                              onClick={() => setVerSelected(i)}
                              title={f.path}
                              className={`max-w-[220px] truncate rounded-lg px-2 py-1 text-[11.5px] transition ${
                                i === verSelected
                                  ? "bg-orange-100 text-stone-900"
                                  : "text-stone-600 hover:bg-orange-50"
                              }`}
                            >
                              <span
                                className={`mr-1 rounded px-1 text-[10px] ${chip.cls}`}
                              >
                                {chip.label}
                              </span>
                              {f.path.split("/").pop()}
                            </button>
                          );
                        })}
                      </div>
                      <div className="min-h-0 flex-1 overflow-auto p-3">
                        {verSelectedFile ? (
                          <DiffBody
                            diff={verSelectedFile.diff || "(fark gösterilemiyor)"}
                          />
                        ) : (
                          <p className="text-[12px] text-stone-400">
                            Bir dosya seç.
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="py-3" />
      </section>
    </main>
  );
}
