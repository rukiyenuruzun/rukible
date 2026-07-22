import { execFile } from "node:child_process";
import { REPO_LIMITS } from "@/lib/config";

/**
 * git komut sarmalayıcıları.
 *
 * Her çağrı `execFile` ile ARGÜMAN DİZİSİ olarak çalışır — asla shell string'i
 * değil. Böylece URL/yol enjeksiyonu (komut enjeksiyonu) mümkün olmaz.
 * Ortam değişkenleri kimlik istemini kapatır: public repo değilse takılıp
 * beklemek yerine hızlıca hata verir.
 */

const NONINTERACTIVE_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "true",
  GCM_INTERACTIVE: "never",
  GIT_CONFIG_NOSYSTEM: "1",
};

type RunResult = { stdout: string; stderr: string };

function run(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30_000,
        env: NONINTERACTIVE_ENV,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & {
            stderr?: string;
            stdout?: string;
          };
          e.stderr = stderr?.toString();
          e.stdout = stdout?.toString();
          reject(e);
        } else {
          resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
        }
      },
    );
  });
}

/** Sığ klon (tek dal, tek commit). `--` ile URL argüman olarak ayrılır. */
export async function cloneRepo(url: string, dest: string): Promise<void> {
  await run(
    [
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      "--filter=blob:limit=10m",
      "--",
      url,
      dest,
    ],
    { timeoutMs: REPO_LIMITS.cloneTimeoutMs },
  );
}

export type GitFileStatus = "added" | "modified" | "deleted";

export type GitChange = { path: string; status: GitFileStatus };

/** `git status --porcelain` çıktısını değişen dosya listesine çevirir. */
export async function statusChanges(cwd: string): Promise<GitChange[]> {
  const { stdout } = await run(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd },
  );
  const changes: GitChange[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw.trim()) continue;
    const code = raw.slice(0, 2);
    let file = raw.slice(3).trim();
    // Yeniden adlandırma: "eski -> yeni" — yeniyi al.
    if (file.includes(" -> ")) file = file.split(" -> ")[1];
    // Tırnaklı yollar (özel karakter) — kabaca temizle.
    file = file.replace(/^"(.*)"$/, "$1");
    let status: GitFileStatus = "modified";
    if (code === "??" || code.includes("A")) status = "added";
    else if (code.includes("D")) status = "deleted";
    changes.push({ path: file, status });
  }
  return changes;
}

/** Tek bir dosyanın unified diff'i. İzlenmeyen dosyalarda /dev/null'a karşı. */
export async function diffFile(
  cwd: string,
  file: string,
  untracked: boolean,
): Promise<string> {
  try {
    const args = untracked
      ? ["diff", "--no-index", "--", "/dev/null", file]
      : ["diff", "--", file];
    const { stdout } = await run(args, { cwd });
    return stdout;
  } catch (err) {
    // `git diff --no-index` fark bulunca çıkış kodu 1 döner ama stdout doludur.
    const e = err as NodeJS.ErrnoException & { stdout?: string };
    if (typeof e.stdout === "string" && e.stdout) return e.stdout;
    const anyErr = err as { stdout?: Buffer | string };
    if (anyErr.stdout) return anyErr.stdout.toString();
    return "";
  }
}
