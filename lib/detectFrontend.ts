import { listTree, readTextFile } from "@/lib/workspace";

/**
 * Klonlanan repo içinde ÇALIŞTIRILABİLİR frontend alt-projesini bulur.
 *
 * Monorepo olabilir (ör. website-next içinde `storefront/`). `dev` scripti olan,
 * next/react/vue gibi bir çatıya bağlı package.json'ları puanlayıp en iyisini
 * seçeriz. Ayrıca hangi paket yöneticisiyle çalışacağını (bun/pnpm/yarn/npm)
 * lock dosyalarından tayin eder.
 */

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export type FrontendTarget = {
  /** Proje köküne göre alt-klasör ("" = kök). */
  subdir: string;
  packageManager: PackageManager;
  /** Çalıştırılacak script adı (genelde "dev"). */
  devScript: string;
  /** Tespit edilen çatı (arayüz metni için). */
  framework: string;
};

const FRAMEWORK_DEPS: Array<[string, string, number]> = [
  ["next", "Next.js", 5],
  ["nuxt", "Nuxt", 5],
  ["@angular/core", "Angular", 5],
  ["astro", "Astro", 4],
  ["vite", "Vite", 3],
  ["@remix-run/react", "Remix", 4],
  ["react", "React", 2],
  ["vue", "Vue", 2],
  ["svelte", "Svelte", 2],
];

const NICE_DIR = /(^|\/)(storefront|frontend|web|website|client|site|www|app|apps\/[^/]+)$/i;

function depth(p: string): number {
  return p === "" ? 0 : p.split("/").length;
}

function dirOf(pkgPath: string): string {
  const i = pkgPath.lastIndexOf("/");
  return i === -1 ? "" : pkgPath.slice(0, i);
}

async function pickPackageManager(
  projectId: string,
  subdir: string,
  allPaths: Set<string>,
): Promise<PackageManager> {
  const inDir = (name: string) =>
    allPaths.has(subdir ? `${subdir}/${name}` : name) || allPaths.has(name);
  // Alt-klasörde ya da kökte lock dosyası ara.
  if (inDir("bun.lock") || inDir("bun.lockb")) return "bun";
  if (inDir("pnpm-lock.yaml")) return "pnpm";
  if (inDir("yarn.lock")) return "yarn";
  return "npm";
}

export async function detectFrontend(
  projectId: string,
): Promise<FrontendTarget | null> {
  const tree = await listTree(projectId);
  const allPaths = new Set(tree.filter((t) => t.type === "file").map((t) => t.path));
  const pkgPaths = tree
    .filter((t) => t.type === "file" && /(^|\/)package\.json$/.test(t.path))
    .map((t) => t.path)
    .filter((p) => !p.includes("node_modules/"));

  let best: (FrontendTarget & { score: number }) | null = null;

  for (const pkgPath of pkgPaths) {
    let pkg: {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    try {
      pkg = JSON.parse(await readTextFile(projectId, pkgPath));
    } catch {
      continue;
    }
    const scripts = pkg.scripts ?? {};
    if (!scripts.dev && !scripts.start && !scripts.develop) continue;
    const devScript = scripts.dev ? "dev" : scripts.develop ? "develop" : "start";

    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    let score = 0;
    let framework = "JS projesi";
    for (const [dep, name, pts] of FRAMEWORK_DEPS) {
      if (deps[dep]) {
        score += pts;
        if (pts >= 2 && framework === "JS projesi") framework = name;
      }
    }
    if (score === 0) continue; // çatısı yoksa atla

    const subdir = dirOf(pkgPath);
    // Sığ olan ve "storefront/frontend/web" gibi anlamlı klasörler öncelikli.
    score += Math.max(0, 4 - depth(subdir));
    if (NICE_DIR.test(subdir)) score += 3;

    if (!best || score > best.score) {
      const packageManager = await pickPackageManager(projectId, subdir, allPaths);
      best = { subdir, packageManager, devScript, framework, score };
    }
  }

  if (!best) return null;
  const { score: _score, ...target } = best;
  void _score;
  return target;
}
