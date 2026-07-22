import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { WORKDIR_ROOT, REPO_LIMITS } from "@/lib/config";

/**
 * ÇALIŞMA ALANI GÜVENLİK BOĞAZI
 *
 * Klonlanan repolar `.rukible-workdir/<projectId>/` altında tutulur. Repoyu
 * düzenleyen model ve önizleme rotası dosyalara SADECE buradaki fonksiyonlarla
 * erişir. Amaç: hiçbir işlem projenin çalışma klasörünün DIŞINA çıkamasın
 * (path traversal + symlink kaçışı). Bu dosyadaki her yol kontrolü kritik.
 */

// ÖNEMLİ: çalışma klasörü Rukible projesinin DIŞINDA olmalı. İçeride olursa
// (klonlanan projenin .next önbelleği, agent dosya yazımları vb.) Rukible'ın
// kendi dev dosya-izleyicisini tetikleyip sunucuyu sürekli yeniden derletir ve
// çalışan dev-sunucu kayıtlarını sıfırlar. O yüzden kullanıcının ev dizini.
export const WORKROOT =
  process.env.RUKIBLE_WORKDIR || path.join(os.homedir(), WORKDIR_ROOT);

/** Yol/erişim ihlallerinde fırlatılır; rotalar 400/403'e çevirir. */
export class WorkdirError extends Error {
  code:
    | "bad_id"
    | "traversal"
    | "denied"
    | "too_large"
    | "binary"
    | "not_found";
  constructor(code: WorkdirError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "WorkdirError";
  }
}

export type TreeEntry = { path: string; type: "file" | "dir"; size?: number };

/** Proje id'si klasör adı olacağı için sıkı doğrulanır (uuid ya da kısa slug). */
export function isValidProjectId(id: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
    /^[a-z0-9-]{6,64}$/i.test(id)
  );
}

/** WORKROOT/<id> — geçersiz id fırlatır. */
export function projectDir(projectId: string): string {
  if (!isValidProjectId(projectId)) {
    throw new WorkdirError("bad_id", "Geçersiz proje kimliği.");
  }
  return path.join(WORKROOT, projectId);
}

/**
 * Göreli bir yolu proje klasörüne göre çözer ve klasör dışına çıkmadığını
 * (senkron/statik olarak) doğrular. Symlink kaçışı için ayrıca
 * `assertRealInside` gerekir — okuma/yazmadan önce çağrılır.
 */
export function safeAbsPath(projectId: string, rel: string): string {
  const base = projectDir(projectId);
  // Baştaki "/" ile mutlak yolları da klasöre göreli sayarız.
  const cleaned = rel.replace(/^[/\\]+/, "");
  const abs = path.resolve(base, cleaned);
  const relFromBase = path.relative(base, abs);
  if (
    relFromBase === ".." ||
    relFromBase.startsWith(".." + path.sep) ||
    path.isAbsolute(relFromBase)
  ) {
    throw new WorkdirError("traversal", "Yol çalışma klasörünün dışına çıkıyor.");
  }
  // .git iç dosyalarına asla dokunma.
  const segs = relFromBase.split(path.sep);
  if (segs.includes(".git")) {
    throw new WorkdirError("denied", ".git klasörüne erişilemez.");
  }
  return abs;
}

/** En yakın var olan üst klasörün gerçek (symlink çözülmüş) yolunu döner. */
async function nearestRealpath(abs: string): Promise<string> {
  let cur = abs;
  // sonsuz döngü olmaz: kök dizine ulaşınca dirname kendine eşitlenir.
  for (;;) {
    try {
      return await fs.realpath(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(cur);
      if (parent === cur) return cur;
      cur = parent;
    }
  }
}

/**
 * Symlink kaçışı guard'ı: hedefin (ya da henüz yoksa en yakın var olan üstünün)
 * GERÇEK yolu proje klasörünün gerçek yolunun içinde mi? Klon içinde dışarıyı
 * gösteren bir symlink varsa burada yakalanır.
 */
export async function assertRealInside(
  projectId: string,
  abs: string,
): Promise<void> {
  const realBase = await fs.realpath(projectDir(projectId));
  const real = await nearestRealpath(abs);
  if (real !== realBase && !real.startsWith(realBase + path.sep)) {
    throw new WorkdirError("traversal", "Sembolik bağ klasör dışını gösteriyor.");
  }
}

// Kaynak dosyalara odaklan: derleme/önbellek/bağımlılık klasörlerini atla.
// (Bunlar hem ağacı şişirir hem de maxFiles kapağını doldurup gerçek kaynak
// dosyalarına — ör. storefront/package.json — ulaşmayı engelleyebilir.)
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  ".vercel",
  ".svelte-kit",
]);

/** Çalışma klasöründeki dosyaları (ve klasörleri) düz liste olarak döner. */
export async function listTree(projectId: string): Promise<TreeEntry[]> {
  const base = projectDir(projectId);
  const out: TreeEntry[] = [];

  async function walk(dirAbs: string, relPrefix: string): Promise<void> {
    if (out.length >= REPO_LIMITS.maxFiles) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= REPO_LIMITS.maxFiles) return;
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        out.push({ path: rel, type: "dir" });
        await walk(path.join(dirAbs, e.name), rel);
      } else if (e.isFile()) {
        let size: number | undefined;
        try {
          size = (await fs.stat(path.join(dirAbs, e.name))).size;
        } catch {
          size = undefined;
        }
        out.push({ path: rel, type: "file", size });
      }
    }
  }

  await walk(base, "");
  return out;
}

/** Klon sonrası boyut denetimi (dosya sayısı + toplam bayt). */
export async function measureRepo(
  projectId: string,
): Promise<{ files: number; bytes: number }> {
  const tree = await listTree(projectId);
  let files = 0;
  let bytes = 0;
  for (const e of tree) {
    if (e.type === "file") {
      files += 1;
      bytes += e.size ?? 0;
    }
  }
  return { files, bytes };
}

const NULL_BYTE = 0;

/** Modelin okuması için metin dosyası döner (ikili dosyaları ve devası reddeder). */
export async function readTextFile(
  projectId: string,
  rel: string,
): Promise<string> {
  const abs = safeAbsPath(projectId, rel);
  await assertRealInside(projectId, abs);

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new WorkdirError("not_found", `Dosya yok: ${rel}`);
  }
  if (!stat.isFile()) throw new WorkdirError("not_found", `Dosya değil: ${rel}`);
  if (stat.size > REPO_LIMITS.maxReadBytes) {
    throw new WorkdirError(
      "too_large",
      `Dosya çok büyük (${stat.size} bayt), okunmadı: ${rel}`,
    );
  }
  const buf = await fs.readFile(abs);
  if (buf.subarray(0, 8000).includes(NULL_BYTE)) {
    throw new WorkdirError("binary", `İkili dosya, metin olarak okunamaz: ${rel}`);
  }
  return buf.toString("utf8");
}

/** Yazımı yasak dosyaları reddeder (.git, .env*). */
function assertWritable(rel: string): void {
  const parts = rel.replace(/^[/\\]+/, "").split(/[/\\]/);
  if (parts.includes(".git")) {
    throw new WorkdirError("denied", ".git klasörüne yazılamaz.");
  }
  const baseName = parts[parts.length - 1] ?? "";
  if (/^\.env/i.test(baseName)) {
    throw new WorkdirError("denied", ".env dosyalarına yazılamaz.");
  }
}

/** Modelin yazması için: boyut sınırlı, sandboxlı, üst klasörleri oluşturur. */
export async function writeTextFile(
  projectId: string,
  rel: string,
  content: string,
): Promise<void> {
  assertWritable(rel);
  const abs = safeAbsPath(projectId, rel);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > REPO_LIMITS.maxWriteBytes) {
    throw new WorkdirError(
      "too_large",
      `İçerik çok büyük (${bytes} bayt), yazılmadı: ${rel}`,
    );
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  // mkdir sonrası symlink kontrolü (üst klasör artık var).
  await assertRealInside(projectId, abs);
  await fs.writeFile(abs, content, "utf8");
}

/** Önizleme için ham bayt döner (ikili/asset dahil), yol+symlink güvenli. */
export async function readAsset(
  projectId: string,
  relSegments: string[],
): Promise<{ buffer: Buffer; absPath: string }> {
  const rel = relSegments.join("/");
  const abs = safeAbsPath(projectId, rel);
  await assertRealInside(projectId, abs);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new WorkdirError("not_found", `Bulunamadı: ${rel}`);
  }
  const buffer = await fs.readFile(abs);
  return { buffer, absPath: abs };
}

/** Bir yolun klasör olup olmadığını güvenli şekilde söyler. */
export async function isDirectory(
  projectId: string,
  relSegments: string[],
): Promise<boolean> {
  try {
    const abs = safeAbsPath(projectId, relSegments.join("/"));
    const stat = await fs.stat(abs);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function workdirExists(projectId: string): Promise<boolean> {
  try {
    const stat = await fs.stat(projectDir(projectId));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/** Çalışma klasörünü tümüyle siler (yeniden klonlama / proje silme). */
export async function removeWorkdir(projectId: string): Promise<void> {
  await fs.rm(projectDir(projectId), { recursive: true, force: true });
}
