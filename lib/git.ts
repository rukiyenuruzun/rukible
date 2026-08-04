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

/** Bir ref'in SHA'sını döner (örn. "HEAD"). */
export async function revParse(cwd: string, ref: string): Promise<string> {
  const { stdout } = await run(["rev-parse", ref], { cwd });
  return stdout.trim();
}

/** Üzerinde durulan dalın adını döner (single-branch klonda uzak varsayılan dal). */
export async function currentBranch(cwd: string): Promise<string> {
  const { stdout } = await run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return stdout.trim();
}

/** origin uzak adresini döner (klonlama sırasında doğrulanmış URL). */
export async function remoteUrl(cwd: string): Promise<string> {
  const { stdout } = await run(["remote", "get-url", "origin"], { cwd });
  return stdout.trim();
}

/** Çalışma kopyasındaki TÜM değişiklikleri tek commit yapar; yeni SHA'yı döner. */
export async function commitAll(cwd: string, message: string): Promise<string> {
  await run(["add", "-A"], { cwd });
  // Kimlik repo/global config'e yazılmaz; sadece bu commit için geçilir.
  await run(
    ["-c", "user.name=Rukible", "-c", "user.email=rukible@localhost", "commit", "-m", message],
    { cwd },
  );
  return revParse(cwd, "HEAD");
}

/**
 * commitAll gibi ama değişiklik yoksa commit denemez (git boş commit'i hata
 * sayar). Bir şey commit'lendiyse yeni SHA'yı, hiçbir şey değişmemişse null
 * döner. Ajan turu / geri alma öncesi "kontrol noktası" için kullanılır.
 */
export async function commitAllIfChanged(
  cwd: string,
  message: string,
): Promise<string | null> {
  await run(["add", "-A"], { cwd });
  const { stdout } = await run(["status", "--porcelain"], { cwd });
  if (!stdout.trim()) return null; // sahne boş — commit'lenecek şey yok
  await run(
    ["-c", "user.name=Rukible", "-c", "user.email=rukible@localhost", "commit", "-m", message],
    { cwd },
  );
  return revParse(cwd, "HEAD");
}

/**
 * Sığ (depth-1) klonun taban commit'i. Sığ klonda sınır commit'i yerel repoda
 * EBEVEYNSİZ (kök) görünür; üstüne attığımız kontrol noktalarının ebeveyni olur.
 * Böylece "klon anındaki ilk hâl" her zaman `--max-parents=0` ile bulunur —
 * klon rotasına dokunmadan, mevcut çalışma klasörlerinde de çalışır.
 */
export async function shallowBaseSha(cwd: string): Promise<string> {
  const { stdout } = await run(["rev-list", "--max-parents=0", "HEAD"], { cwd });
  const roots = stdout.trim().split("\n").filter(Boolean);
  // Tek kök beklenir; birden çoksa en eskisini (son satır) al.
  return roots[roots.length - 1] ?? "";
}

/**
 * Hedef sürüme (sha) "döner" ama YIKICI DEĞİL: hiçbir sürümü silmez. Hedefin
 * ağacını çalışma kopyasına getirip HEAD'in ÜSTÜNE yeni bir kontrol noktası
 * olarak commit'ler. Böylece ileri geçmiş korunur (istenirse tekrar ileri
 * gidilebilir), tıpkı /yeni'deki sürüm geri yüklemesi gibi.
 *
 * Adımlar: (1) commit'siz elle düzenlemeleri önce kaydet (kaybolmasın),
 * (2) reset --hard <sha> ile ağacı hedefe getir, (3) reset --soft <oldHead> ile
 * HEAD'i geri al (ağaç hedefte kalır, fark index'te evrelenir), (4) fark varsa
 * commit. Dönen değer yeni HEAD (hiç fark yoksa oldHead — no-op).
 */
export async function revertToVersion(
  cwd: string,
  sha: string,
  message: string,
): Promise<string> {
  await commitAllIfChanged(cwd, "Geri alma öncesi otomatik kayıt");
  const oldHead = await revParse(cwd, "HEAD");
  await run(["reset", "--hard", sha], { cwd });
  await run(["reset", "--soft", oldHead], { cwd });
  const { stdout } = await run(["status", "--porcelain"], { cwd });
  if (!stdout.trim()) return oldHead; // zaten o içerikteyiz — değişiklik yok
  await run(
    ["-c", "user.name=Rukible", "-c", "user.email=rukible@localhost", "commit", "-m", message],
    { cwd },
  );
  return revParse(cwd, "HEAD");
}

export type CommitInfo = { sha: string; at: number; message: string };

/**
 * `range` (ör. "<base>..HEAD") aralığındaki commit'leri YENİDEN→ESKİYE döner.
 * Alanlar arasında \x1f, satırlar arasında \x1e ayırıcısı (mesajda newline
 * olabildiği için güvenli sınırlayıcı).
 */
export async function logRange(
  cwd: string,
  range: string,
): Promise<CommitInfo[]> {
  const { stdout } = await run(
    ["log", "--format=%H%x1f%ct%x1f%s%x1e", range],
    { cwd },
  );
  const out: CommitInfo[] = [];
  for (const rec of stdout.split("\x1e")) {
    const line = rec.replace(/^\n/, "");
    if (!line.trim()) continue;
    const [sha, at, ...rest] = line.split("\x1f");
    if (!sha) continue;
    out.push({ sha, at: Number(at) || 0, message: rest.join("\x1f") });
  }
  return out;
}

/**
 * `git diff --name-status <refs...>` çıktısını değişen dosya listesine çevirir.
 * refs = ["<base>"] (taban↔çalışma ağacı) ya da ["<from>", "<to>"] (iki commit).
 */
export async function diffNameStatus(
  cwd: string,
  refs: string[],
): Promise<GitChange[]> {
  const { stdout } = await run(
    ["diff", "--name-status", "--find-renames", ...refs],
    { cwd },
  );
  const changes: GitChange[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw.trim()) continue;
    const parts = raw.split("\t");
    const code = parts[0] ?? "";
    // Yeniden adlandırma/kopyalama (R100, C75): son alan YENİ yol.
    const file = parts[parts.length - 1] ?? "";
    if (!file) continue;
    let status: GitFileStatus = "modified";
    if (code.startsWith("A")) status = "added";
    else if (code.startsWith("D")) status = "deleted";
    else if (code.startsWith("R") || code.startsWith("C")) status = "added";
    changes.push({ path: file, status });
  }
  return changes;
}

/**
 * Tek dosyanın iki ref (ya da taban↔çalışma ağacı) arasındaki unified diff'i.
 * `refs` diffFile ile aynı mantık: git diff <refs...> -- <file>.
 */
export async function diffFileRefs(
  cwd: string,
  refs: string[],
  file: string,
): Promise<string> {
  try {
    const { stdout } = await run(["diff", ...refs, "--", file], { cwd });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string };
    if (typeof e.stdout === "string" && e.stdout) return e.stdout;
    return "";
  }
}

/** Commit'i geri alır ama dosya değişikliklerini çalışma ağacında bırakır. */
export async function resetMixed(cwd: string, sha: string): Promise<void> {
  await run(["reset", "--mixed", sha], { cwd });
}

/**
 * HEAD'i uzak repodaki hedef dala gönderir. Kimlik `pushUrl` içindedir (origin
 * config'ine yazılmaz, diske token sızmaz). Refspec "HEAD:" ile başladığı için
 * dal adı hiçbir zaman komut seçeneği gibi ayrıştırılamaz.
 */
export async function pushHeadTo(
  cwd: string,
  pushUrl: string,
  branch: string,
): Promise<void> {
  await run(["push", pushUrl, `HEAD:refs/heads/${branch}`], {
    cwd,
    timeoutMs: 60_000,
  });
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

/** İzlenmeyen (henüz git'e hiç girmemiş) dosyalar — göreli yollar. */
export async function untrackedFiles(cwd: string): Promise<string[]> {
  const { stdout } = await run(
    ["ls-files", "--others", "--exclude-standard"],
    { cwd },
  );
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
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
