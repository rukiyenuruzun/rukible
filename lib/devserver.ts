import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, writeSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { safeAbsPath } from "@/lib/workspace";
import type { FrontendTarget } from "@/lib/detectFrontend";

/**
 * ÇATI ÖNİZLEMESİ — dev sunucusu yöneticisi.
 *
 * Klonlanan bir frontend alt-projesini (ör. Next.js) `install` edip `dev`
 * sunucusunu ayrı bir portta çalıştırır; iframe o portu gösterir.
 *
 * SAĞLAMLIK:
 *  - Süreç TAM BAĞIMSIZ başlatılır: stdout/stderr bir DOSYAYA yazılır (ebeveyne
 *    pipe DEĞİL), `detached` + `unref`. Böylece Rukible dev sunucusu (Next HMR)
 *    yeniden derlense/başlasa bile storefront süreci EPIPE'tan çökmez, yaşar.
 *  - Kayıt `globalThis`'te tutulur (HMR modül reload'ında kaybolmaz).
 *  - Her projeye SABİT port; başlatmadan önce port zaten yanıt veriyorsa (yetim
 *    ama yaşayan sunucu) yeniden kullanılır.
 *
 * GÜVENLİK: bu, KLONLANAN REPONUN KODUNU çalıştırır. v1 tek-kullanıcı/yerel.
 */

export type DevStatus = "installing" | "starting" | "ready" | "error" | "stopped";

export type DevServer = {
  projectId: string;
  status: DevStatus;
  port: number;
  subdir: string;
  framework: string;
  packageManager: string;
  error?: string;
  proc: ChildProcess | null;
  startedAt: number;
  /** iframe'in bağlandığı çerçeve proxy portu (bkz. startFrameProxy). */
  framePort?: number;
};

type FrameProxy = { server: http.Server; port: number };

const g = globalThis as unknown as {
  __rukibleDev?: Map<string, DevServer>;
  __rukibleFrame?: Map<string, FrameProxy>;
};
const registry: Map<string, DevServer> = (g.__rukibleDev ??= new Map());
const frames: Map<string, FrameProxy> = (g.__rukibleFrame ??= new Map());

const READY_TIMEOUT_MS = 180_000;

function logFile(projectId: string): string {
  return path.join(os.tmpdir(), `rukible-dev-${projectId}.log`);
}

/** Kendi durum satırlarımızı log dosyasına ekler (dosya = tek doğruluk kaynağı). */
function appendLog(projectId: string, msg: string): void {
  try {
    const fd = openSync(logFile(projectId), "a");
    for (const l of msg.split(/\r?\n/)) {
      if (l.trim()) writeSync(fd, l + "\n");
    }
    closeSync(fd);
  } catch {
    // yoksay
  }
}

function readLog(projectId: string, lastN = 60): string[] {
  try {
    const txt = readFileSync(logFile(projectId), "utf8");
    return txt.split("\n").filter(Boolean).slice(-lastN);
  } catch {
    return [];
  }
}

/** Projenin dev sunucusu portu (dışarıya açık — proxy rotası kullanır). */
export function previewPort(projectId: string): number {
  return stablePort(projectId);
}

/** Projeye deterministik bir port (41000–60999). Yeniden başlatmada aynı kalır. */
function stablePort(projectId: string): number {
  let h = 0;
  for (let i = 0; i < projectId.length; i++) {
    h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
  }
  return 41000 + (h % 20000);
}

/** Bir portta HTTP yanıt veren bir sunucu var mı? */
async function probe(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * ÇERÇEVE (iframe) PROXY'Sİ
 *
 * Dev sunucusunu BİREBİR (aynı yollarla, yeniden yazma olmadan) ikinci bir
 * porttan sunar; sadece yanıt başlıklarına dokunur.
 *
 * NEDEN GEREKLİ — Firefox'ta sonsuz yenilenme döngüsü:
 *  Firefox, ÇAPRAZ-ORIGIN bir iframe'de `PerformanceNavigationTiming.transferSize`
 *  değerini 0 raporluyor. Next 16'nın dev istemcisi (`client/dev/debug-channel.js`)
 *  bunu "sayfa HTTP önbelleğinden geldi" sanıp sessionStorage'daki debug kanalını
 *  arıyor; bulamayınca `location.reload()` çağırıyor → sayfa baştan yükleniyor →
 *  aynı şey tekrar → saniyede birkaç kez yenilenen, hiç oturmayan bir önizleme
 *  (uçuştaki chunk istekleri de iptal olduğu için ChunkLoadError'lar).
 *  `Timing-Allow-Origin: *` transferSize'ı çapraz-origin'e görünür kılıyor ve
 *  döngü tamamen bitiyor (ölçüldü: 20 yükleme/15sn → 1 yükleme).
 *
 * Yollar değişmediği için uygulama "native" çalışır: HMR web soketi (upgrade
 * aktarılıyor), hydration ve fare/animasyon etkileşimleri tam.
 * Ek olarak framing engelleri (X-Frame-Options / CSP frame-ancestors) sıyrılır.
 */
function startFrameProxy(projectId: string, devPort: number): Promise<number> {
  const existing = frames.get(projectId);
  if (existing) return Promise.resolve(existing.port);

  const rewriteLocation = (loc: string, framePort: number): string =>
    loc.replace(
      new RegExp(`^(https?://)(127\\.0\\.0\\.1|localhost):${devPort}`, "i"),
      `$1localhost:${framePort}`,
    );

  const server = http.createServer((req, res) => {
    const upstream = http.request(
      { host: "127.0.0.1", port: devPort, path: req.url, method: req.method, headers: req.headers },
      (up) => {
        const headers: http.OutgoingHttpHeaders = { ...up.headers };
        delete headers["x-frame-options"];
        delete headers["content-security-policy"];
        delete headers["content-security-policy-report-only"];
        headers["timing-allow-origin"] = "*";
        const loc = headers["location"];
        const port = (server.address() as AddressInfo | null)?.port;
        if (typeof loc === "string" && port) headers["location"] = rewriteLocation(loc, port);
        res.writeHead(up.statusCode ?? 502, headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("Önizleme sunucusuna ulaşılamadı.");
    });
    req.pipe(upstream);
  });

  // HMR web soketi (ve diğer upgrade'ler) ham olarak aktarılır.
  server.on("upgrade", (req, socket: Duplex, head: Buffer) => {
    const upstream = http.request({
      host: "127.0.0.1",
      port: devPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
    });
    upstream.on("upgrade", (up, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`];
      for (let i = 0; i < up.rawHeaders.length; i += 2) {
        lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
      }
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      if (upHead?.length) socket.write(upHead);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      upSocket.on("error", () => socket.destroy());
      socket.on("error", () => upSocket.destroy());
    });
    upstream.on("error", () => socket.destroy());
    if (head?.length) upstream.write(head);
    upstream.end();
  });

  server.on("clientError", (_e, socket) => socket.destroy());

  // Tercihen dev portunun bir fazlası; doluysa serbest bir port.
  const preferred = devPort + 1;
  return new Promise<number>((resolve, reject) => {
    const settle = () => {
      const port = (server.address() as AddressInfo).port;
      frames.set(projectId, { server, port });
      appendLog(projectId, `✓ çerçeve proxy'si hazır: http://localhost:${port}`);
      resolve(port);
    };
    const onError = (e: NodeJS.ErrnoException) => {
      if (e.code !== "EADDRINUSE") return reject(e);
      server.once("error", reject);
      server.listen(0, "127.0.0.1", settle);
    };
    server.once("error", onError);
    server.listen(preferred, "127.0.0.1", () => {
      server.removeListener("error", onError);
      settle();
    });
  });
}

function stopFrameProxy(projectId: string): void {
  const f = frames.get(projectId);
  if (!f) return;
  frames.delete(projectId);
  try {
    f.server.closeAllConnections?.();
    f.server.close();
  } catch {
    // yoksay
  }
}

/**
 * Dev sunucusu hazırsa çerçeve proxy'sinin ayakta olduğundan emin olur.
 * (Rukible süreci yeniden başladıysa proxy kaybolmuş olabilir.)
 */
export async function ensureFramePort(projectId: string): Promise<number | undefined> {
  const ds = registry.get(projectId);
  if (!ds || ds.status !== "ready") return undefined;
  try {
    ds.framePort = await startFrameProxy(projectId, ds.port);
    return ds.framePort;
  } catch {
    return undefined;
  }
}

async function waitUntilReady(ds: DevServer): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (ds.status === "error" || ds.status === "stopped") return;
    if (await probe(ds.port)) {
      ds.status = "ready";
      appendLog(ds.projectId, `✓ dev sunucusu hazır: http://localhost:${ds.port}`);
      ds.framePort = await startFrameProxy(ds.projectId, ds.port).catch(() => undefined);
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (ds.status === "starting") {
    ds.status = "error";
    ds.error = "Dev sunucusu zamanında yanıt vermedi.";
    appendLog(ds.projectId, "✗ zaman aşımı: dev sunucusu hazır olmadı");
  }
}

/**
 * Klonlanan repoya verilecek ortam değişkenleri — SADECE bu liste geçer.
 *
 * GÜVENLİK: burada çalışan kod GÜVENİLMEZ (kullanıcının verdiği bir repo).
 * `{...process.env}` yayılımı bu koda Rukible'ın TÜM sırlarını miras verirdi:
 * SUPABASE_SERVICE_KEY (RLS'i baypas eder → tüm veritabanı), OPENROUTER_API_KEY
 * (fatura), APP_PASSWORD (araca giriş), SESSION_SECRET. Kötü niyetli bir reponun
 * `postinstall` scriptine üç satır yazması yeterdi.
 *
 * Reponun kodunu çalıştırmak bu özelliğin doğası gereği kaçınılmaz; ama ona
 * sırlarımızı vermek kaçınılabilir. Bu liste "çalışsın diye gereken" en küçük
 * kümedir: PATH olmadan node/npm bulunamaz, HOME olmadan paket önbelleği
 * yazılamaz.
 */
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "npm_config_cache",
  "NVM_DIR",
  "NVM_BIN",
] as const;

function childEnv(port: number): NodeJS.ProcessEnv {
  // NODE_ENV baştan verilir: NodeJS.ProcessEnv tipi onu zorunlu tutuyor.
  const env: NodeJS.ProcessEnv = { NODE_ENV: "development" };
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return Object.assign(env, {
    PORT: String(port),
    // Miras alınan NODE_ENV=production, install'da devDependencies'i atlayıp
    // `next dev`i çalışmaz hale getirir — burası her zaman geliştirme ortamı.
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    BROWSER: "none",
    CI: "1",
    // iron-session vb. güçlü bir SESSION_SECRET bekler; yoksa render'da çöker.
    // Rukible'ın kendi sırrı DEĞİL: önizleme başına tek kullanımlık üretilir.
    SESSION_SECRET: randomBytes(24).toString("hex"),
    // Önizlemeyi iframe'de gösterebilmek için: X-Frame-Options: DENY gibi
    // framing engellerini yalnızca bu ortamda kapatmayı sağlar (uygulamanın
    // kodu bu env'i kontrol ederse). Üretimde etkisizdir.
    RUKIBLE_ALLOW_FRAME: "1",
  });
}

/** Bir komutu BAĞIMSIZ (dosyaya loglayan, detached) çocuk olarak çalıştırır. */
function spawnDetached(
  projectId: string,
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { proc: ChildProcess; done: Promise<number> } {
  appendLog(projectId, `$ ${cmd} ${args.join(" ")}`);
  const out = openSync(logFile(projectId), "a");
  const proc = spawn(cmd, args, {
    cwd,
    env,
    detached: true, // kendi süreç grubu + ebeveyneden bağımsız
    stdio: ["ignore", out, out], // pipe DEĞİL → ebeveyn restart olsa çökmez
  });
  try {
    closeSync(out);
  } catch {
    // fd çocuk tarafından tutuluyor; ebeveyn kopyasını kapatabiliriz
  }
  proc.unref();
  const done = new Promise<number>((resolve) => {
    proc.on("error", (e) => {
      appendLog(projectId, `süreç hatası: ${e.message}`);
      resolve(-1);
    });
    proc.on("exit", (code) => resolve(code ?? -1));
  });
  return { proc, done };
}

/** Dev sunucusunu başlatır (gerekiyorsa önce install). İdempotent. */
export async function startDevServer(
  projectId: string,
  target: FrontendTarget,
): Promise<DevServer> {
  const port = stablePort(projectId);

  // Yaşayan bir sunucu bu portta zaten çalışıyorsa (bu süreç ya da yetim bir
  // önceki) yeniden kullan — mükerrer süreç açma.
  if (await probe(port)) {
    const existing = registry.get(projectId);
    const ds: DevServer = {
      projectId,
      status: "ready",
      port,
      subdir: target.subdir,
      framework: target.framework,
      packageManager: target.packageManager,
      proc: existing?.proc ?? null,
      startedAt: existing?.startedAt ?? Date.now(),
    };
    registry.set(projectId, ds);
    ds.framePort = await startFrameProxy(projectId, port).catch(() => undefined);
    return ds;
  }

  const cwd = safeAbsPath(projectId, target.subdir || ".");

  const ds: DevServer = {
    projectId,
    status: "installing",
    port,
    subdir: target.subdir,
    framework: target.framework,
    packageManager: target.packageManager,
    proc: null,
    startedAt: Date.now(),
  };
  registry.set(projectId, ds);

  const pm = target.packageManager;
  const baseEnv = childEnv(port);

  void (async () => {
    const hasModules = existsSync(path.join(cwd, "node_modules"));
    if (!hasModules) {
      const { done } = spawnDetached(projectId, pm, ["install"], cwd, baseEnv);
      const code = await done;
      if (code !== 0) {
        ds.status = "error";
        ds.error = `${pm} install başarısız (kod ${code}).`;
        return;
      }
    } else {
      appendLog(projectId, "node_modules mevcut — install atlandı");
    }
    if (ds.status === "stopped") return;

    ds.status = "starting";
    const { proc, done } = spawnDetached(projectId, pm, ["run", target.devScript], cwd, baseEnv);
    ds.proc = proc;
    void done.then((code) => {
      if (ds.status !== "stopped" && ds.status !== "ready") {
        ds.status = "error";
        ds.error = ds.error ?? `dev sunucusu durdu (kod ${code}).`;
      }
    });

    await waitUntilReady(ds);
  })();

  return ds;
}

export function getDevServer(
  projectId: string,
): (Omit<DevServer, "proc"> & { logs: string[] }) | null {
  const ds = registry.get(projectId);
  if (!ds) return null;
  const { proc: _proc, ...snap } = ds;
  void _proc;
  return { ...snap, logs: readLog(projectId) };
}

export function stopDevServer(projectId: string): boolean {
  const ds = registry.get(projectId);
  const port = stablePort(projectId);
  stopFrameProxy(projectId);
  let killed = false;
  const proc = ds?.proc;
  if (proc && proc.pid) {
    try {
      process.kill(-proc.pid, "SIGTERM");
      killed = true;
    } catch {
      try {
        proc.kill("SIGTERM");
        killed = true;
      } catch {
        // yoksay
      }
    }
  }
  if (ds) {
    ds.status = "stopped";
    registry.delete(projectId);
  }
  void port;
  return killed || !!ds;
}
