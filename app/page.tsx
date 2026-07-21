"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Logo, SLOGAN } from "./logo";
import { applyPatches } from "@/lib/patch";
import { SITE_URL } from "@/lib/config";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  /** Bitiş mesajını renklendirmek için: iş tamamlandı mı, kısmen mi. */
  tone?: "ok" | "warn";
  /** true ise bu asistan mesajı bir plandır; altında "Uygula" düğmesi çıkar. */
  plan?: boolean;
  /** true ise kullanıcı bu mesaja bir görsel iliştirdi (sohbette işaret gösterilir). */
  hasImage?: boolean;
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

/**
 * SOHBET YEDEĞİ — tarayıcıda saklanır.
 *
 * Sohbet, projeye dönünce eskiden yalnızca kaydedilmiş SÜRÜMLERDEN yeniden
 * kuruluyordu. Uygulanamayan (başarısız) istekler sürüm üretmediği için her
 * yenilemede kayboluyordu. Artık sohbetin tamamını burada tutuyoruz: başarılı
 * ya da başarısız, hiçbir mesaj silinmez. Supabase local'de bulunmadığından bu
 * yedek, dev sunucu yeniden başlasa bile sohbeti korur.
 */
const CHAT_STORE_PREFIX = "rukible_chat_v1_";

type ChatSnapshot = { messages: ChatMessage[]; html: string };

function chatStoreKey(projectId?: string | null): string {
  return CHAT_STORE_PREFIX + (projectId ?? "local");
}

function loadChatSnapshot(projectId?: string | null): ChatSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(chatStoreKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.messages)) {
      return {
        messages: parsed.messages,
        html: typeof parsed.html === "string" ? parsed.html : "",
      };
    }
  } catch {
    // bozuk ya da erişilemez yedek — yok say
  }
  return null;
}

function saveChatSnapshot(
  projectId: string | null | undefined,
  snap: ChatSnapshot,
): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(chatStoreKey(projectId), JSON.stringify(snap));
  } catch {
    // depolama kotası dolabilir; sessiz geç
  }
}

/**
 * Bir görsel dosyasını küçültüp data URL'e çevirir. Ekran görüntüleri büyük
 * olabiliyor; uzun kenarı en fazla 1600px'e indirip JPEG %85 ile kodluyoruz —
 * hem maliyet hem de model sınırları için makul boyut.
 */
function fileToDataUrl(file: File, maxDim = 1600, quality = 0.85): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (Math.max(width, height) > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("canvas yok"));
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("görsel okunamadı"));
    };
    img.src = url;
  });
}

/** Model bazen ```html ... ``` sarmalıyla döndürür; onu temizler. */
function extractHtml(raw: string): string {
  const fenced = raw.match(/```(?:html)?\s*([\s\S]*?)(?:```|$)/i);
  return (fenced ? fenced[1] : raw).trim();
}

/**
 * Çoklu adımlı bir isteği tek tek adımlara böler.
 *
 * Model çok işi aynı anda kotaramıyor; onun yerine numaralı adımları ayırıp her
 * birini ayrı, küçük bir düzenleme olarak sırayla uyguluyoruz. Bir "Uygulanacak
 * adımlar" bölümü varsa oradan başlıyoruz.
 *
 * Önce numaralı adımları ("N." / "N)") arar; 1-2 haneli sayı + nokta/parantez +
 * boşluk desenini kullanır, böylece "IEC 60529.", "IP54-IP68", "0.4s" gibi metin
 * içi sayılar bölünmez. Numara yoksa CÜMLE sınırlarından böler (kullanıcı çoğu
 * kez "şunu yap. bunu yap. şunu düzelt." diye yazar). Tek anlamlı parça çıkarsa
 * boş döner (tek istek gibi işlenir).
 */
function parseSteps(text: string): string[] {
  // 1) Numaralı adımlar — "Uygulanacak adımlar" bölümü varsa oradan başla.
  const idx = text.search(/uygulanacak ad[ıi]mlar/i);
  const scope = idx !== -1 ? text.slice(idx) : text;
  const numbered: string[] = [];
  const re = /(?:^|\s)\d{1,2}[.)]\s+([\s\S]*?)(?=\s\d{1,2}[.)]\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope)) !== null) {
    const s = m[1].replace(/\s+/g, " ").trim();
    if (s.length > 3) numbered.push(s);
  }
  if (numbered.length >= 2) return numbered.slice(0, 12);

  // 2) Numara yoksa cümle/satır sınırlarından böl. Her parça en az 2 kelime ve
  //    8 karakter olsun ki "Evet." gibi doldurma cümleler adım sayılmasın.
  const pieces = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(
      (s) => s.replace(/[.!?]+$/, "").trim().split(/\s+/).length >= 2 && s.length >= 8,
    );
  if (pieces.length >= 2) return pieces.slice(0, 8);

  return [];
}

/**
 * Önizlemeye basılacak HTML'i hazırlar.
 *
 * Önizleme srcdoc ile yüklendiği için sayfanın gerçek bir adresi yok
 * (about:srcdoc). Bu yüzden bağlantılara tıklamayı tarayıcıya bırakırsak:
 *  - "#bölüm" gibi sayfa içi bağlantılar üst pencerenin adresine göre
 *    çözülür (localhost/#bölüm) ve şifre kapısına takılır,
 *  - "/urunler" gibi bağlantılar da yine bizim uygulamaya gitmeye çalışır.
 *
 * Çözüm: sayfa içi (#) bağlantıları biz yakalayıp hedef bölümü bulup oraya
 * kaydırıyoruz — böylece "IP sınıfından başla" gibi butonlar gerçekten iner.
 * Diğer (dış/başka sayfa) bağlantılar ile form gönderimleri engelli kalır;
 * önizleme gezinmek için değil bakmak için. Hover, animasyon, açılır menü
 * gibi her şey çalışmaya devam eder.
 */
function previewDoc(html: string, editMode = false): string {
  if (!html) return html;

  const guard = `<script data-rukible="1">
var RUKIBLE_EDIT = ${editMode ? "true" : "false"};
document.addEventListener('click', function (e) {
  var a = e.target && e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  // href özelliği değil, ham değeri: srcdoc'ta özellik mutlak adrese çözülür.
  var href = a.getAttribute('href') || '';
  if (href.charAt(0) === '#') {
    e.preventDefault();
    // Düzenleme modunda tıklamak metni değiştirmek içindir; kaydırma yapma.
    if (RUKIBLE_EDIT) return;
    var id = href.slice(1);
    try { id = decodeURIComponent(id); } catch (err) {}
    if (!id) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    var t = document.getElementById(id) ||
            document.getElementsByName(id)[0];
    if (t && t.scrollIntoView) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  // Dış veya başka sayfaya giden bağlantılar: önizlemede gezinme yok.
  e.preventDefault();
}, true);
document.addEventListener('submit', function (e) { e.preventDefault(); }, true);
</script>`;

  // Metin düzenleme modu: yalnızca doğrudan metin taşıyan öğeler yazılabilir
  // olur. Değişiklikler ana pencereye postMessage ile bildirilir; önizleme
  // yeniden yüklenmediği için imleç kaybolmaz.
  const editor = `<style data-rukible="1">
  [contenteditable="true"]:hover { outline: 1px dashed rgba(251,146,60,.7); outline-offset: 3px; }
  [contenteditable="true"]:focus { outline: 2px solid rgba(251,146,60,.9); outline-offset: 3px; }
</style>
<script data-rukible="1">
(function () {
  var SEC = 'h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,span,a,button,figcaption,blockquote,label,strong,em';
  function enable() {
    document.querySelectorAll(SEC).forEach(function (el) {
      if (el.closest('[data-rukible]')) return;
      // Sadece yaprak öğeler: içinde başka etiket yoksa ve metni varsa.
      if (el.children.length === 0 && el.textContent && el.textContent.trim()) {
        el.setAttribute('contenteditable', 'true');
        el.setAttribute('spellcheck', 'false');
      }
    });
  }
  function serialize() {
    var clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('[data-rukible]').forEach(function (n) { n.remove(); });
    clone.querySelectorAll('[contenteditable]').forEach(function (n) {
      n.removeAttribute('contenteditable');
      n.removeAttribute('spellcheck');
    });
    return '<!DOCTYPE html>\\n' + clone.outerHTML;
  }
  var timer = null;
  document.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      parent.postMessage({ type: 'rukible:html', html: serialize() }, '*');
    }, 300);
  }, true);
  // Enter yeni paragraf açmasın, satır sonu koysun.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target && e.target.isContentEditable) {
      e.preventDefault();
      document.execCommand('insertLineBreak');
    }
  }, true);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enable);
  } else {
    enable();
  }
})();
</script>`;

  const inject = editMode ? guard + editor : guard;

  // </head> varsa oraya, yoksa başa ekle.
  return html.includes("</head>")
    ? html.replace("</head>", `${inject}</head>`)
    : inject + html;
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

  // Build: mesaj sayfayı değiştirir. Plan: model sadece ne yapılacağını konuşur,
  // sayfaya dokunulmaz; çıkan planın altındaki "Uygula" ile Build'e geçirilir.
  const [mode, setMode] = useState<"build" | "plan">("build");
  // Plan modunda akan metni canlı göstermek için (bitince mesaja dönüşür).
  const [planDraft, setPlanDraft] = useState("");
  // Sıradaki mesaja iliştirilecek görsel (ekran görüntüsü vb.) — data URL.
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  // Üretim stili (yeni sayfalar için). Düzenleme mevcut sayfanın diline uyar.
  const [style, setStyle] = useState("muhendis");

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
  const [usage, setUsage] = useState<{
    kalan?: number;
    limit?: number;
    bugun?: number;
    uretimSayisi?: number;
  } | null>(null);
  const [showUsage, setShowUsage] = useState(false);

  const [elapsed, setElapsed] = useState(0);

  const [panelWidth, setPanelWidth] = useState(380);
  const [confirmVersion, setConfirmVersion] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  /**
   * Elle yapılan düzenlemeler burada birikir — state'te DEĞİL.
   * State'e yazsak önizleme her tuş vuruşunda yeniden yüklenir ve imleç kaybolur.
   */
  const editedRef = useRef<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const draggingRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Görsel seçildiğinde: küçült, data URL'e çevir, sıradaki mesaja iliştir. */
  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // aynı dosyayı tekrar seçebilmek için sıfırla
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Sadece görsel (resim) eklenebilir.");
      return;
    }
    try {
      setPendingImage(await fileToDataUrl(file));
    } catch {
      setError("Görsel işlenemedi.");
    }
  }

  /**
   * Açılışta sohbet yedekten geri kurulana kadar kaydetmeyi bekletir; aksi
   * halde ilk boş render mevcut yedeği ezerdi.
   */
  const restoredRef = useRef(false);

  // Sohbeti sakla: başarısız istekler dahil hiçbir mesaj yenilemede kaybolmasın.
  // Yedek, o an açık projeye (yoksa "local") göre anahtarlanır.
  useEffect(() => {
    if (!restoredRef.current) return;
    saveChatSnapshot(project?.id ?? null, { messages, html });
  }, [messages, html, project?.id]);

  // Panel genişliğini ve seçili stili hatırla.
  useEffect(() => {
    const saved = Number(localStorage.getItem("rukible_panel"));
    if (saved >= 300 && saved <= 720) setPanelWidth(saved);
    const savedStyle = localStorage.getItem("rukible_style");
    if (savedStyle) setStyle(savedStyle);
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
      localStorage.setItem("rukible_panel", String(panelWidth));
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [panelWidth]);

  // Önizlemeden gelen düzenlemeleri dinle.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type !== "rukible:html") return;
      if (typeof e.data.html !== "string") return;
      editedRef.current = e.data.html;
      setDirty(true);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /** Harcama özetini tazeler — açılışta ve her üretimden sonra. */
  const refreshUsage = useCallback(() => {
    fetch("/api/kullanim")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setUsage(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshUsage();
  }, [refreshUsage]);

  /** Yazdıkça çubuğu büyütür, belli bir yükseklikten sonra kendi içinde kaydırır. */
  function autoGrow() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }

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
      .then(async (r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) {
          // Supabase yok (ör. local): sohbeti yerel yedekten geri getir ki
          // yenilemede/dev sunucu restart'ında kaybolmasın.
          const snap = loadChatSnapshot(null);
          if (snap) {
            setMessages(snap.messages);
            if (snap.html) setHtml(snap.html);
          }
          return;
        }
        setDbReady(true);
        setProjects(data.projects ?? []);
        // Sayfa yenilendiğinde son çalışılan proje kendiliğinden açılsın —
        // aksi halde her yenilemede her şey kaybolmuş gibi görünüyor.
        const latest = data.projects?.[0];
        if (latest) loadProject(latest.id);
      })
      .catch(() => {
        const snap = loadChatSnapshot(null);
        if (snap) {
          setMessages(snap.messages);
          if (snap.html) setHtml(snap.html);
        }
      })
      .finally(() => {
        // İlk kurulum bitti: bundan sonra sohbet değişiklikleri kaydedilebilir.
        restoredRef.current = true;
      });
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

    // Sohbeti öncelikle yerel yedekten geri getir — başarısız istekler dahil
    // her mesaj orada. Yedek yoksa (ör. başka cihazda açılmış proje) sürüm
    // geçmişinden yeniden kur: her sürüm onu üreten isteği saklıyor.
    restoredRef.current = true;
    const snap = loadChatSnapshot(id);
    if (snap && snap.messages.length) {
      setMessages(snap.messages);
    } else {
      const history: ChatMessage[] = [];
      for (const v of [...(data.versions ?? [])].reverse()) {
        if (!v.prompt) continue;
        history.push({ role: "user", content: v.prompt });
        history.push({ role: "assistant", content: "Uygulandı.", tone: "ok" });
      }
      setMessages(history);
    }

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

  async function send(preset?: string, asBuild?: boolean) {
    const text = (preset ?? input).trim();
    // Görsel varsa metin olmadan da gönderilebilir.
    const img = pendingImage;
    if ((!text && !img) || streaming) return;

    // "Uygula" düğmesi asBuild=true geçer: seçili mod ne olursa olsun Build çalışır.
    const activeMode: "build" | "plan" = asBuild ? "build" : mode;

    setError(null);
    setNotes([]);
    setCost(null);
    setPendingImage(null); // iliştirildi; kutuyu boşalt
    setStatus(
      activeMode === "plan"
        ? "Planlanıyor…"
        : text.includes("http")
          ? "Sayfa taranıyor…"
          : "Düşünüyor…",
    );
    setInput("");
    requestAnimationFrame(autoGrow); // gönderdikten sonra çubuk eski boyuna dönsün
    // API'ye gerçek metni gönder; ekranda görselli boş mesajı "📷 Görsel" göster.
    const apiMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    const nextMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: text || "📷 Görsel", hasImage: !!img },
    ];
    setMessages(nextMessages);

    // Çoklu adım (numaralı istek) + ortada sayfa varsa: tek seferde değil, her
    // adımı ayrı küçük bir düzenleme olarak SIRAYLA uygula ve tek tek raporla.
    // Görsel eklendiyse bölme — görsel bağlamı isteğin tamamına uygulanmalı.
    if (activeMode === "build" && html && !img) {
      const steps = parseSteps(text);
      if (steps.length >= 2) {
        await applyStepwise(steps, text, nextMessages);
        return;
      }
    }

    setStreaming(true);

    // Plan modu sürüm üretmez; boş proje açmamak için yalnızca mevcut projeyi kullan.
    const target = activeMode === "plan" ? project : await ensureProject(text || "görsel");

    try {
      const controller = new AbortController();
      abortRef.current = controller;

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages,
          currentHtml: html || undefined,
          mode: activeMode === "plan" ? "plan" : undefined,
          image: img || undefined,
          style,
        }),
        signal: controller.signal,
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
      let serverMode: "create" | "edit" | "plan" = "create";
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
            m?: "create" | "edit" | "plan";
            u?: { cost?: number };
          };
          try {
            msg = JSON.parse(raw);
          } catch {
            continue;
          }

          if (msg.m) serverMode = msg.m;
          if (msg.n) setNotes((prev) => [...prev, msg.n!]);
          if (msg.r) setStatus(serverMode === "plan" ? "Planlanıyor…" : "Düşünüyor…");
          if (msg.u?.cost != null) {
            spent = msg.u.cost;
            setCost(msg.u.cost);
          }
          if (msg.c) {
            accumulated += msg.c;
            if (serverMode === "plan") {
              // Plan metnini sohbete CANLI akıt — okurken beklemek yerine oluşurken gör.
              setPlanDraft(accumulated);
            } else {
              // Önizlemeyi akış sırasında GÜNCELLEMİYORUZ. Yarım HTML basmak
              // iframe'i her seferinde yeniden yükletiyor; ekran titriyor ve
              // sayfa bozukmuş gibi görünüyor. Sonucu bir kerede basıyoruz.
              setStatus(serverMode === "edit" ? "Değişiklik hazırlanıyor…" : "Sayfa yazılıyor…");
            }
          }
        }
      }

      if (serverMode === "plan") {
        // Plan modu: sayfaya dokunma, sürüm kaydetme. Planı "Uygula" düğmeli bir
        // asistan mesajına çevir.
        setPlanDraft("");
        const planText = accumulated.trim();
        setMessages([
          ...nextMessages,
          planText
            ? { role: "assistant", content: planText, plan: true }
            : { role: "assistant", content: "Plan üretemedim, tekrar dener misin?", tone: "warn" },
        ]);
      } else {
        let reply = "Sayfa hazır — sağda görebilirsin.";
        let tone: "ok" | "warn" = "ok";
        let finalHtml = "";

        if (serverMode === "edit") {
          const result = applyPatches(html, accumulated);
          finalHtml = result.html;
          setHtml(result.html);

          // Model "bunu yapamam" dediyse (ör. sayfada artık olmayan bir bölümü
          // geri getirmek): açıklamasını olduğu gibi gösteriyoruz.
          let cantDoText = "";
          const cd = accumulated.indexOf("---YAPILAMADI---");
          if (cd !== -1) {
            cantDoText = accumulated.slice(cd + "---YAPILAMADI---".length);
            const oz = cantDoText.indexOf("---ÖZET---");
            if (oz !== -1) cantDoText = cantDoText.slice(0, oz);
            cantDoText = cantDoText.trim();
          }

          // Modelin en sona koyduğu "---ÖZET---" listesi: ne değiştirdiğini söyler.
          const summary = accumulated.match(/---ÖZET---\s*([\s\S]*)$/);
          const changes = summary
            ? summary[1]
                .split("\n")
                .map((l) => l.replace(/^\s*[-•*]\s*/, "").trim())
                .filter(Boolean)
            : [];

          if (result.applied === 0) {
            if (cantDoText) {
              reply = cantDoText;
              tone = "warn";
            } else {
              // Yama tutmadı (model metni birebir kopyalayamadı). Pes etmek yerine
              // sayfayı tam yeniden yazarak uygula — pahalı ama güvenilir yedek.
              setStatus("Yama tutmadı, sayfayı yeniden yazarak uyguluyorum…");
              const rewrite = await streamOnce(
                [{ role: "user", content: text }],
                html,
                controller.signal,
                "fulledit",
                img,
              );
              if (rewrite.cost != null) {
                spent = (spent ?? 0) + rewrite.cost;
                setCost(spent);
              }
              const newHtml = extractHtml(rewrite.content);
              const looksValid =
                /<(!doctype|html)[\s>]/i.test(newHtml) && newHtml.length > html.length * 0.5;
              if (looksValid) {
                finalHtml = newHtml;
                setHtml(newHtml);
                reply = "Hızlı yama tutmadı; sayfayı yeniden yazarak uyguladım.";
                tone = "ok";
                await saveVersion(target, newHtml, text, spent);
              } else {
                reply =
                  "Değişikliği uygulayamadım — isteği biraz daha net yazar mısın? " +
                  "(Birden fazla şey istiyorsan numaralandırarak yaz, daha yeniyim.)";
                tone = "warn";
              }
            }
          } else {
            setNotes((prev) => [...prev, ...result.notes]);
            // Dürüst rapor: gerçek uygulanan sayıyı esas al, modelin dediğini göster.
            reply = changes.length
              ? changes.map((c) => `• ${c}`).join("\n")
              : `${result.applied} değişiklik uyguladım.`;
            if (result.failed > 0) {
              reply +=
                `\n⚠ ${result.failed} değişiklik sayfaya tutmadı. ` +
                "İstediğin tam olmadıysa sağdaki sürüm geçmişinden geri alabilirsin.";
              tone = "warn";
            }
            await saveVersion(target, finalHtml, text, spent);
          }
        } else {
          finalHtml = extractHtml(accumulated);
          setHtml(finalHtml);
          await saveVersion(target, finalHtml, text, spent);
        }

        setMessages([...nextMessages, { role: "assistant", content: reply, tone }]);
      }
    } catch (err) {
      // Kullanıcı durdurduysa bu bir hata değil.
      if (err instanceof DOMException && err.name === "AbortError") {
        setMessages([
          ...nextMessages,
          { role: "assistant", content: "Durduruldu.", tone: "warn" },
        ]);
      } else {
        setError(err instanceof Error ? err.message : "Beklenmeyen bir hata oluştu.");
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      setStatus("");
      setPlanDraft(""); // yarım kalan plan taslağını temizle
      refreshUsage();
    }
  }

  /** Bir planı Build modunda çalıştırır (plan mesajının "Uygula" düğmesi). */
  function applyPlan(planText: string) {
    const steps = parseSteps(planText);
    if (steps.length >= 2 && html) {
      const nextMessages: ChatMessage[] = [
        ...messages,
        { role: "user", content: "Planı uygula" },
      ];
      setMessages(nextMessages);
      applyStepwise(steps, "Planı uygula", nextMessages);
    } else {
      // Tek adımlık plan ya da henüz sayfa yoksa normal akış.
      send(`Aşağıdaki planı uygula:\n\n${planText}`, true);
    }
  }

  /** Tek bir düzenleme çağrısını akıtır; içeriği ve maliyeti döndürür. */
  async function streamOnce(
    msgs: ChatMessage[],
    baseHtml: string,
    signal: AbortSignal,
    reqMode?: "fulledit",
    image?: string | null,
  ): Promise<{ content: string; cost: number | null }> {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: msgs,
        currentHtml: baseHtml || undefined,
        mode: reqMode,
        image: image || undefined,
      }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(await res.text());

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let cost: number | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        if (!raw.trim()) continue;
        let msg: { c?: string; n?: string; u?: { cost?: number } };
        try {
          msg = JSON.parse(raw);
        } catch {
          continue;
        }
        if (msg.c) content += msg.c;
        if (msg.n) setNotes((prev) => [...prev, msg.n!]);
        if (msg.u?.cost != null) cost = msg.u.cost;
      }
    }
    return { content, cost };
  }

  /**
   * Çoklu adımlı bir isteği SIRAYLA uygular: her adımı ayrı küçük bir düzenleme
   * olarak çalıştırır, sonucu bir sonraki adıma taşır ve her adımı tek tek
   * raporlar ("✓ 1. …", "✗ 2. … uygulanamadı"). Küçük düzenlemeler güvenilir
   * tuttuğu için hem daha sağlam çalışır hem de ne yapıldığını net gösterir.
   */
  async function applyStepwise(
    steps: string[],
    originalText: string,
    baseMessages: ChatMessage[],
  ) {
    setError(null);
    setNotes([]);
    setCost(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const target = await ensureProject(originalText);
    let workingHtml = html;
    let msgs = baseMessages;
    let totalCost = 0;
    let anyApplied = false;

    try {
      for (let i = 0; i < steps.length; i++) {
        setStatus(`Adım ${i + 1}/${steps.length}…`);
        const { content, cost } = await streamOnce(
          [{ role: "user", content: steps[i] }],
          workingHtml,
          controller.signal,
        );
        if (cost) totalCost += cost;

        const result = applyPatches(workingHtml, content);
        // Yalnızca gerçek yama uygulandıysa sayfayı ilerlet; tek adımda tüm
        // sayfayı yeniden yazmasına (full) veya boş dönmesine izin verme.
        let ok = result.mode === "patch" && result.applied > 0;
        if (ok) {
          workingHtml = result.html;
          setHtml(workingHtml);
          anyApplied = true;
        } else {
          // Bu adımın yaması tutmadı — tam yeniden yazımla dene (güvenilir yedek).
          setStatus(`Adım ${i + 1}/${steps.length} — yeniden yazımla…`);
          const rw = await streamOnce(
            [{ role: "user", content: steps[i] }],
            workingHtml,
            controller.signal,
            "fulledit",
          );
          if (rw.cost) totalCost += rw.cost;
          const newHtml = extractHtml(rw.content);
          if (/<(!doctype|html)[\s>]/i.test(newHtml) && newHtml.length > workingHtml.length * 0.5) {
            workingHtml = newHtml;
            setHtml(workingHtml);
            anyApplied = true;
            ok = true;
          }
        }

        // Kullanıcının cümlesini tekrar etme — modelin NE YAPTIĞINI (ÖZET) yaz.
        // (Baştaki ✓/! işaretini mesaj kutusu kendisi ekliyor, buraya koymuyoruz.)
        const ozet = content.match(/---ÖZET---\s*([\s\S]*)/);
        const done = ozet
          ? ozet[1]
              .split("\n")
              .map((l) => l.replace(/^\s*[-•*]\s*/, "").trim())
              .filter(Boolean)
              .join("; ")
          : "";

        msgs = [
          ...msgs,
          {
            role: "assistant",
            content: ok
              ? `${i + 1}. ${done || "yapıldı"}`
              : `${i + 1}. ${steps[i]} — uygulanamadı`,
            tone: ok ? "ok" : "warn",
          },
        ];
        setMessages(msgs);
      }

      if (anyApplied) await saveVersion(target, workingHtml, originalText, totalCost || null);
      setCost(totalCost || null);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setMessages([...msgs, { role: "assistant", content: "Durduruldu.", tone: "warn" }]);
      } else {
        setError(err instanceof Error ? err.message : "Beklenmeyen bir hata oluştu.");
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      setStatus("");
      refreshUsage();
    }
  }

  /**
   * Üretimi durdurur.
   *
   * Not: istek sunucuda başladıysa model o ana kadar ürettiği için ücret
   * yansıyabilir. Durdurmak beklemeyi bitirir, faturayı geri almaz.
   */
  function stop() {
    abortRef.current?.abort();
  }

  /**
   * Metin düzenleme modundan çıkar.
   * kaydet=true ise değişiklikler yeni bir versiyon olarak saklanır.
   */
  async function finishEdit(kaydet: boolean) {
    const edited = editedRef.current;
    setEditMode(false);
    editedRef.current = null;

    if (!kaydet || !dirty || !edited) {
      setDirty(false);
      return;
    }

    setSaving(true);
    setHtml(edited);
    // Elle düzenleme modeli hiç çağırmaz — maliyeti sıfır.
    await saveVersion(project, edited, "Elle düzenlendi", 0);
    setDirty(false);
    setSaving(false);
  }

  /** Tek bir versiyonu siler. */
  async function removeVersion(id: string) {
    const res = await fetch(`/api/versions/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError(await res.text());
      return;
    }
    const kalan = versions.filter((v) => v.id !== id);
    setVersions(kalan);
    setConfirmVersion(null);

    // Görüntülenen versiyonu sildiysek en yeniye dön.
    if (versionId === id) {
      const next = kalan[0];
      setHtml(next?.html ?? "");
      setVersionId(next?.id ?? null);
      setShareUrl(null);
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
    // Önizleme adresindeysek bile link asıl adresle üretilsin — aksi halde
    // karşı taraf Vercel girişi ister.
    const base = (SITE_URL || window.location.origin).replace(/\/+$/, "");
    setShareUrl(`${base}/p/${slug}`);
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
      setEditMode(false);
      setDirty(false);
      editedRef.current = null;
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
    // Projenin sohbet yedeğini de temizle — arkada çöp kalmasın.
    if (typeof window !== "undefined") {
      try {
        localStorage.removeItem(chatStoreKey(id));
      } catch {
        // erişilemezse önemli değil
      }
    }
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
      <section
        style={{ width: panelWidth }}
        className="flex shrink-0 flex-col overflow-hidden"
      >
        <header className="px-7 py-6">
          <div className="flex items-center gap-3">
            <Logo size={30} />
            <div className="leading-none">
              <div className="text-[23px] font-semibold tracking-tight text-stone-800">
                Rukible
              </div>
              <div className="mt-1.5 text-[12px] text-orange-400">{SLOGAN}</div>
            </div>
          </div>

          {dbReady && (
            <div className="mt-5">
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-stone-400">
                Sohbet
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setShowProjects((s) => !s);
                    setConfirmDelete(null);
                  }}
                  className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-xl bg-white px-3 py-2 text-[13px] font-medium text-stone-800 shadow-[0_1px_2px_rgba(120,80,60,0.06)] transition hover:bg-orange-50"
                >
                  <span className="truncate">
                    {project ? project.title : "Yeni sohbet"}
                  </span>
                  <span className="shrink-0 text-stone-400">▾</span>
                </button>
                <button
                  onClick={newProject}
                  title="Yeni sohbet başlat"
                  className="shrink-0 rounded-xl bg-orange-400 px-3 py-2 text-[13px] font-medium text-white transition hover:bg-orange-500"
                >
                  + Yeni
                </button>
              </div>
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
                      className={`min-w-0 flex-1 truncate rounded-xl px-3 py-2 text-left text-[12.5px] transition hover:bg-orange-100 ${
                        project?.id === p.id
                          ? "bg-orange-400 font-medium text-white hover:bg-orange-500"
                          : "text-stone-600 hover:text-stone-900"
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
                          className="rounded-lg px-2 py-1 text-[12px] text-stone-500 transition hover:bg-orange-100 hover:text-stone-900"
                        >
                          Adlandır
                        </button>
                        <button
                          onClick={() => setConfirmDelete(p.id)}
                          title="Sohbeti sil"
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
          )}
        </header>

        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-7 pb-4">
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
            ) : m.tone ? (
              <p
                key={i}
                className={`flex items-start gap-2 whitespace-pre-line rounded-2xl px-4 py-2.5 text-[13px] leading-relaxed ${
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

          {planDraft && (
            <div className="rounded-2xl border border-orange-200 bg-orange-50/60 px-4 py-3">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-orange-500">
                <span aria-hidden="true">◇</span> Plan
              </div>
              <div className="whitespace-pre-line text-[13px] leading-relaxed text-stone-700">
                {planDraft}
              </div>
            </div>
          )}

          {notes.map((n, i) => (
            <p key={i} className="text-[11px] text-stone-400">
              ✳︎ {n}
            </p>
          ))}

          {streaming && !planDraft && (
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

        {/* Harcama — her zaman görünür, tıklayınca ayrıntı açılır. */}
        {usage?.kalan != null && (
          <div className="px-7 pb-3">
            <button
              onClick={() => setShowUsage((s) => !s)}
              className="flex w-full items-center justify-between rounded-xl bg-white/60 px-3 py-2 text-[11.5px] transition hover:bg-white"
            >
              <span className="text-stone-500">Kalan kredi</span>
              <span
                className={`font-medium tabular-nums ${
                  usage.kalan < 1 ? "text-rose-600" : "text-stone-700"
                }`}
              >
                ${usage.kalan.toFixed(2)}
              </span>
            </button>

            {showUsage && (
              <div className="mt-1.5 space-y-1 px-3 text-[11px] text-stone-400">
                {usage.limit != null && (
                  <div className="flex justify-between">
                    <span>Toplam kredi</span>
                    <span className="tabular-nums">${usage.limit.toFixed(2)}</span>
                  </div>
                )}
                {usage.bugun != null && (
                  <div className="flex justify-between">
                    <span>Bugün harcanan</span>
                    <span className="tabular-nums">${usage.bugun.toFixed(4)}</span>
                  </div>
                )}
                {usage.uretimSayisi != null && (
                  <div className="flex justify-between">
                    <span>Toplam üretim</span>
                    <span className="tabular-nums">{usage.uretimSayisi}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="px-7 pb-7">
          {/* Öneriler yalnızca boş bir sohbette, yazma çubuğunun hemen üstünde. */}
          {messages.length === 0 && !streaming && (
            <div className="mb-3 space-y-1.5">
              <p className="text-[11px] text-stone-400">Şunları deneyebilirsin</p>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => send(ex)}
                  className="block w-full rounded-xl bg-white/70 px-3 py-2 text-left text-[12.5px] leading-snug text-stone-600 transition hover:bg-orange-100 hover:text-stone-900"
                >
                  {ex}
                </button>
              ))}
            </div>
          )}

          <div className="rounded-3xl bg-white/80 p-2 shadow-[0_1px_3px_rgba(120,80,60,0.06)]">
            {/* Build / Plan geçişi + görsel ekle */}
            <div className="mb-1 flex items-center gap-1 px-1">
              <button
                onClick={() => setMode("build")}
                title="Sayfayı değiştirir"
                className={`rounded-full px-3 py-1 text-[11.5px] font-medium transition ${
                  mode === "build"
                    ? "bg-orange-400 text-white"
                    : "text-stone-400 hover:text-stone-600"
                }`}
              >
                Build
              </button>
              <button
                onClick={() => setMode("plan")}
                title="Sayfaya dokunmadan ne yapılacağını konuşur"
                className={`rounded-full px-3 py-1 text-[11.5px] font-medium transition ${
                  mode === "plan"
                    ? "bg-orange-400 text-white"
                    : "text-stone-400 hover:text-stone-600"
                }`}
              >
                Plan
              </button>
              <select
                value={style}
                onChange={(e) => {
                  setStyle(e.target.value);
                  localStorage.setItem("rukible_style", e.target.value);
                }}
                title="Üretim stili — yeni sayfalar bu stille üretilir"
                className="rounded-full bg-white px-2 py-1 text-[11px] text-stone-600 outline-none ring-1 ring-stone-200"
              >
                <option value="muhendis">Mühendis</option>
                <option value="canli">Canlı</option>
                <option value="minimal">Minimal</option>
                <option value="serbest">Serbest</option>
              </select>
              <button
                onClick={() => fileRef.current?.click()}
                title="Görsel ekle (ekran görüntüsü) — model görüp anlar"
                className="ml-auto rounded-full px-2.5 py-1 text-[13px] text-stone-400 transition hover:bg-orange-100 hover:text-stone-700"
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
                  ? "Ne yapmak istediğini konuş — sayfa değişmez"
                  : "Nasıl bir sayfa olsun?"
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
                onClick={() => send()}
                disabled={!input.trim()}
                className="w-full rounded-2xl bg-orange-400 py-2.5 text-[13px] font-medium text-white transition hover:bg-orange-500 disabled:bg-stone-100 disabled:text-stone-300"
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

      {/* SAĞ — önizleme */}
      <section className="flex min-w-0 flex-1 flex-col pr-4">
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
            {editMode ? (
              <span className="flex items-center gap-2">
                <span className="text-[11.5px] text-orange-500">
                  {dirty ? "Değişiklik var" : "Metne tıkla, yaz"}
                </span>
                <button
                  onClick={() => finishEdit(true)}
                  disabled={saving}
                  className="rounded-xl bg-orange-400 px-3.5 py-1.5 text-[12.5px] font-medium text-white transition hover:bg-orange-500 disabled:bg-stone-200"
                >
                  {saving ? "Kaydediliyor…" : "Kaydet"}
                </button>
                <button
                  onClick={() => finishEdit(false)}
                  className="rounded-xl px-2.5 py-1.5 text-[12.5px] text-stone-500 transition hover:text-stone-900"
                >
                  Vazgeç
                </button>
              </span>
            ) : (
              <button
                onClick={() => {
                  setDirty(false);
                  editedRef.current = null;
                  setEditMode(true);
                }}
                disabled={!html || streaming}
                className="rounded-xl bg-white px-3.5 py-1.5 text-[12.5px] font-medium text-stone-700 shadow-[0_1px_2px_rgba(120,80,60,0.06)] transition hover:bg-orange-100 hover:text-stone-900 disabled:bg-white/50 disabled:text-stone-300 disabled:hover:bg-white/50"
              >
                Metni düzenle
              </button>
            )}

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
              className="rounded-xl bg-white px-3.5 py-1.5 text-[12.5px] font-medium text-stone-700 shadow-[0_1px_2px_rgba(120,80,60,0.06)] transition hover:bg-orange-100 hover:text-stone-900 disabled:bg-white/50 disabled:text-stone-300 disabled:hover:bg-white/50"
            >
              Paylaş
            </button>
            <button
              onClick={download}
              disabled={!html}
              className="rounded-xl bg-white px-3.5 py-1.5 text-[12.5px] font-medium text-stone-700 shadow-[0_1px_2px_rgba(120,80,60,0.06)] transition hover:bg-orange-100 hover:text-stone-900 disabled:bg-white/50 disabled:text-stone-300 disabled:hover:bg-white/50"
            >
              İndir
            </button>
          </div>
        </header>

        {versions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pb-3 pl-2 text-[11px]">
            <span className="py-1 text-stone-400">Geçmiş</span>
            {versions.map((v, i) =>
              confirmVersion === v.id ? (
                <span
                  key={v.id}
                  className="flex items-center gap-1 rounded-lg bg-rose-50 px-1.5 py-1"
                >
                  <button
                    onClick={() => removeVersion(v.id)}
                    className="rounded px-1.5 text-rose-700 transition hover:bg-rose-200"
                  >
                    sil
                  </button>
                  <button
                    onClick={() => setConfirmVersion(null)}
                    className="rounded px-1.5 text-stone-500 transition hover:text-stone-800"
                  >
                    vazgeç
                  </button>
                </span>
              ) : (
                <span
                  key={v.id}
                  className={`group flex items-center rounded-lg transition ${
                    v.id === versionId
                      ? "bg-orange-400 text-white"
                      : "bg-white text-stone-600 hover:bg-orange-100"
                  }`}
                >
                  <button
                    onClick={() => restore(v)}
                    title={v.prompt ?? ""}
                    className={`px-2.5 py-1 ${
                      v.id === versionId ? "font-medium" : "hover:text-stone-900"
                    }`}
                  >
                    v{versions.length - i} · {clock(v.created_at)}
                  </button>
                  <button
                    onClick={() => setConfirmVersion(v.id)}
                    title="Bu versiyonu sil"
                    className={`px-1.5 text-[13px] leading-none opacity-0 transition group-hover:opacity-100 ${
                      v.id === versionId
                        ? "text-white/70 hover:text-white"
                        : "text-stone-400 hover:text-rose-600"
                    }`}
                  >
                    ×
                  </button>
                </span>
              ),
            )}
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
              srcDoc={html ? previewDoc(html, editMode) : EMPTY_STATE}
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
