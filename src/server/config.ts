import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

// Everything the app can't detect on its own. Lives next to sources.json; absent keys mean "auto-detect".
const FILE = join(homedir(), ".config/skill-manager/config.json");
export type Config = { satlRepo?: string; abcConfig?: string; repos: string[] };

export const readConfig = (): Config => ({ repos: [], ...(existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {}) });

const expand = (p: string) => resolve(p.trim().replace(/^~(?=$|\/)/, homedir()));
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** Saves a partial update. Empty strings clear a setting (back to auto-detect); paths must exist. */
export function writeConfig(patch: Partial<Config>) {
  const next = readConfig();
  if (patch.satlRepo !== undefined) {
    const p = patch.satlRepo.trim() && expand(patch.satlRepo);
    if (p && !isDir(join(p, "knowledge-base"))) throw new Error(`${p} has no knowledge-base folder — point to your auditboard-satl clone`);
    next.satlRepo = p || undefined;
  }
  if (patch.abcConfig !== undefined) {
    const p = patch.abcConfig.trim() && expand(patch.abcConfig);
    if (p && !existsSync(p)) throw new Error(`${p} doesn't exist`);
    next.abcConfig = p || undefined;
  }
  if (patch.repos) {
    const repos = patch.repos.map(expand);
    const bad = repos.filter((r) => !isDir(r));
    if (bad.length) throw new Error(`Not a folder: ${bad.join(", ")}`);
    next.repos = [...new Set(repos)];
  }
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(next, null, 2) + "\n");
  return next;
}

type Found = { path?: string; source: "settings" | "env" | "abc" | "default" | null };

/** abc's config: Settings, else its default location. */
export function abcConfig(): Found {
  const c = readConfig().abcConfig;
  if (c) return { path: c, source: "settings" };
  const def = join(homedir(), ".config/abc/config.yml");
  return existsSync(def) ? { path: def, source: "default" } : { source: null };
}

export function abcRepos(): Record<string, string> {
  const { path } = abcConfig();
  if (!path) return {};
  try {
    return (Bun.YAML.parse(readFileSync(path, "utf8")) as { repos?: Record<string, string> }).repos ?? {};
  } catch {
    return {};
  }
}

/** The SATL knowledge-base clone: Settings → $SATL_REPO_PATH → abc's auditboard-satl → the usual spots. */
export function satlRepo(): Found {
  const kb = (p?: string) => !!p && isDir(join(p, "knowledge-base"));
  const c = readConfig().satlRepo;
  if (kb(c)) return { path: c, source: "settings" };
  if (kb(process.env.SATL_REPO_PATH)) return { path: process.env.SATL_REPO_PATH, source: "env" };
  const fromAbc = abcRepos()["auditboard-satl"];
  if (kb(fromAbc)) return { path: fromAbc, source: "abc" };
  for (const p of [join(homedir(), ".satl"), join(homedir(), "auditboard/repos/auditboard-satl")]) if (kb(p)) return { path: p, source: "default" };
  return { source: null };
}

/** What the Settings screen shows: each dependency, where it was found, or that it's missing. */
export function detect() {
  const which = (bin: string) => Bun.which(bin) ?? undefined;
  const abc = abcConfig();
  const satl = satlRepo();
  return {
    claude: which("claude"),
    npx: which("npx"),
    git: which("git"),
    abc: { ...abc, cli: which("abc"), repos: Object.keys(abcRepos()).length },
    satl: { ...satl, cli: which("satl") },
    repos: readConfig().repos,
  };
}
