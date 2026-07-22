import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, writeSync } from "node:fs";
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
};

const g = globalThis as unknown as { __rukibleDev?: Map<string, DevServer> };
const registry: Map<string, DevServer> = (g.__rukibleDev ??= new Map());

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

async function waitUntilReady(ds: DevServer): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (ds.status === "error" || ds.status === "stopped") return;
    if (await probe(ds.port)) {
      ds.status = "ready";
      appendLog(ds.projectId, `✓ dev sunucusu hazır: http://localhost:${ds.port}`);
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
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    NEXT_TELEMETRY_DISABLED: "1",
    BROWSER: "none",
    CI: "1",
    // iron-session vb. güçlü bir SESSION_SECRET bekler; yoksa render'da çöker.
    SESSION_SECRET: process.env.SESSION_SECRET || randomBytes(24).toString("hex"),
    // Önizlemeyi iframe'de gösterebilmek için: X-Frame-Options: DENY gibi
    // framing engellerini yalnızca bu ortamda kapatmayı sağlar (uygulamanın
    // kodu bu env'i kontrol ederse). Üretimde etkisizdir.
    RUKIBLE_ALLOW_FRAME: "1",
  };

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
