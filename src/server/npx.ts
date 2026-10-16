import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { frontmatter } from "./frontmatter";

// Everything `npx skills` (vercel-labs/skills 1.7.x): its global lock, update detection, and add/remove.
// `skills check` can't be used for detection — it's an alias that *applies* updates.
const LOCK = join(process.env.XDG_STATE_HOME ? join(process.env.XDG_STATE_HOME, "skills") : join(homedir(), ".agents"), ".skill-lock.json");
const CLAUDE_SKILLS = join(homedir(), ".claude/skills");

type Entry = { source: string; sourceType: string; ref?: string; skillPath?: string; skillFolderHash?: string };

export type UpdateStatus = {
  name: string;
  source: string;
  path: string; // folder in the source repo
  // moved: same folder name now lives elsewhere in the repo · removed: no folder by that name anymore
  status: "current" | "update" | "moved" | "removed" | "error";
  movedTo?: string;
  inClaude: boolean; // false = installed only for other agents (Codex, Pi…) in ~/.agents/skills
  error?: string;
};

// takenBy: ~/.claude/skills already has a skill with this name from somewhere else (another repo, another folder, your own)
export type RepoSkill = { name: string; path: string; description: string; installed: "claude" | "other-agents" | null; takenBy?: string };

/** Drop one skill from the global lock (after every copy of it is gone). Written via temp file + rename so a crash can't truncate it. */
export function dropLockEntry(name: string) {
  if (!existsSync(LOCK)) return;
  const lock = JSON.parse(readFileSync(LOCK, "utf8"));
  if (!lock.skills?.[name]) return;
  delete lock.skills[name];
  const tmp = `${LOCK}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(lock, null, 2));
  renameSync(tmp, LOCK);
}

export const lockEntries = (): Record<string, Entry> => (existsSync(LOCK) ? (JSON.parse(readFileSync(LOCK, "utf8")).skills ?? {}) : {});

const folderOf = (skillPath: string) => skillPath.replace(/\/?SKILL\.md$/, "");
const inClaude = (name: string) => existsSync(join(CLAUDE_SKILLS, name));

let token: string | undefined | null = null;
function githubToken() {
  if (token !== null) return token;
  token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    const gh = Bun.spawnSync(["gh", "auth", "token"]); // anonymous API = 60 req/h; with a token it's 5000
    token = gh.success ? gh.stdout.toString().trim() : undefined;
  }
  return token;
}

type Tree = { sha: string; tree: { path: string; type: string; sha: string }[] };
const treeCache = new Map<string, { at: number; tree: Tree }>();

async function tree(source: string, ref?: string, fresh = false): Promise<Tree> {
  const key = `${source}#${ref ?? ""}`;
  const hit = treeCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.tree;
  const auth = githubToken();
  for (const branch of ref ? [ref] : ["HEAD", "main", "master"]) {
    const res = await fetch(`https://api.github.com/repos/${source}/git/trees/${branch}?recursive=1`, {
      headers: { Accept: "application/vnd.github.v3+json", ...(auth && { Authorization: `Bearer ${auth}` }) },
    });
    if (res.ok) {
      const t = (await res.json()) as Tree;
      treeCache.set(key, { at: Date.now(), tree: t });
      return t;
    }
    if (res.status !== 404) throw new Error(`GitHub ${res.status} for ${source}`);
  }
  throw new Error(`No branch found for ${source}`);
}

/** Every SKILL.md folder in a repo ("" = the repo root itself is the skill). */
const skillFolders = (t: Tree) => t.tree.filter((n) => n.type === "blob" && /(^|\/)SKILL\.md$/.test(n.path)).map((n) => folderOf(n.path));

/** Same algorithm as `skills update`: skillFolderHash is the git tree sha of the skill's folder. */
/** `source` limits the check to one repo; `fresh` skips the 60s tree cache (the "check now" buttons). */
export async function checkUpdates(opts: { source?: string; fresh?: boolean } = {}): Promise<UpdateStatus[]> {
  const entries = Object.entries(lockEntries()).filter(([, e]) => e.sourceType === "github" && e.skillPath && e.skillFolderHash && (!opts.source || e.source === opts.source));
  const bySource = Map.groupBy(entries, ([, e]) => `${e.source}#${e.ref ?? ""}`);
  const results = await Promise.all(
    [...bySource.values()].map(async (group) => {
      const { source, ref } = group[0]![1];
      try {
        const t = await tree(source, ref, opts.fresh);
        const folders = skillFolders(t);
        return group.map(([name, e]): UpdateStatus => {
          const folder = folderOf(e.skillPath!);
          const base = { name, source, path: folder, inClaude: inClaude(name) };
          const remote = folder ? t.tree.find((n) => n.type === "tree" && n.path === folder)?.sha : t.sha;
          if (remote) return { ...base, status: remote === e.skillFolderHash ? "current" : "update" };
          // repos get reorganized (mattpocock moved skills/x → skills/engineering/x): look for the same folder name
          const movedTo = folders.find((f) => basename(f) === basename(folder));
          return movedTo ? { ...base, status: "moved", movedTo } : { ...base, status: "removed" };
        });
      } catch (err) {
        return group.map(([name, e]): UpdateStatus => ({
          name,
          source,
          path: folderOf(e.skillPath!),
          inClaude: inClaude(name),
          status: "error",
          error: (err as Error).message,
        }));
      }
    }),
  );
  return results.flat();
}

const descCache = new Map<string, string>();

/** Everything a repo offers, with what's already installed — powers the per-source picker. */
export async function repoSkills(source: string): Promise<RepoSkill[]> {
  const t = await tree(source);
  const locks = lockEntries();
  return Promise.all(
    skillFolders(t).map(async (path) => {
      const name = path ? basename(path) : source.split("/")[1]!;
      const key = `${source}/${path}`;
      if (!descCache.has(key)) {
        const raw = await fetch(`https://raw.githubusercontent.com/${source}/HEAD/${path ? `${path}/` : ""}SKILL.md`).then((r) => (r.ok ? r.text() : ""));
        descCache.set(key, String(frontmatter(raw).description ?? ""));
      }
      const lock = locks[name];
      // same repo can ship two folders with one name (cursor/plugins does): only the locked folder is "this" skill
      const tracked = lock?.source === source && (!lock.skillPath || folderOf(lock.skillPath) === path);
      if (tracked) return { name, path, description: descCache.get(key)!, installed: inClaude(name) ? "claude" : "other-agents" };
      const takenBy = inClaude(name) ? (lock?.source === source ? `another folder of ${source}` : (lock?.source ?? "your own skills")) : undefined;
      return { name, path, description: descCache.get(key)!, installed: null, takenBy };
    }),
  );
}

export const SOURCE = /^[\w.-]+\/[\w.-]+(#[\w./-]+)?(@[\w.:-]+)?$/; // owner/repo[#ref][@skill]: never a flag, path or URL
// must start with a word char: a leading "-" would be parsed as a CLI flag (a "--all" name once wiped ~/.claude/skills)
const NAME = /^\w[\w.:-]*$/;
const FOLDER = /^[\w./-]*$/;

async function runSkills(args: string[], project?: string) {
  // strip agent-detection vars: otherwise the CLI auto-picks targets when this server was started from Claude Code
  const { CLAUDECODE, CLAUDE_CODE, AI_AGENT, ...env } = process.env;
  const proc = Bun.spawn(["npx", "-y", "skills", ...args], { cwd: project ?? homedir(), env: { ...env, DISABLE_TELEMETRY: "1", NO_COLOR: "1", FORCE_COLOR: "0" }, stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(Bun.stripANSI(err).trim().split("\n").slice(-5).join("\n") || `skills exited with ${code}`);
  return out;
}

/** `skills add` for Claude Code only. `skills` limits the install to those names; no names + no @skill = the whole repo. */
export async function add(source: string, opts: { project?: string; skills?: string[]; folder?: string } = {}) {
  if (!SOURCE.test(source)) throw new Error("Expected owner/repo or owner/repo@skill");
  if (opts.skills && !opts.skills.every((n) => NAME.test(n))) throw new Error("Bad skill name");
  if (opts.folder !== undefined && !FOLDER.test(opts.folder)) throw new Error("Bad folder");
  // folder pins the exact location (what `skills update` does), e.g. owner/repo/skills/engineering/tdd
  const target = opts.folder ? `${source}/${opts.folder}` : source;
  const args = ["add", target, "-a", "claude-code", "-y", "--json"];
  if (opts.skills?.length) args.push("--skill", ...opts.skills);
  else if (!source.includes("@")) args.push("--skill", "*");
  if (!opts.project) args.push("-g");
  return JSON.parse(await runSkills(args, opts.project)) as { name: string; status: string; error?: string }[];
}

/**
 * Install picked skills from one repo. `skills add owner/repo` only discovers skills in the usual folders, so ones nested
 * deeper (stablyai/orca resources/…/skills/x) come back as "No matching skills found for: x" — those get installed one by
 * one from their exact folder, the rest in a single batch.
 */
export async function addPicked(source: string, names: string[], project?: string) {
  const folders = Map.groupBy(skillFolders(await tree(source)), (f) => (f ? basename(f) : source.split("/")[1]!));
  const results: { name: string; status: string; error?: string }[] = [];
  let batch = names;
  try {
    results.push(...(await add(source, { project, skills: batch })));
    batch = [];
  } catch (e) {
    const missing = /No matching skills found for: (.+)/.exec((e as Error).message)?.[1]?.split(/,\s*/).map((n) => n.trim());
    if (!missing?.length) throw e;
    batch = batch.filter((n) => !missing.includes(n));
    if (batch.length) results.push(...(await add(source, { project, skills: batch })));
    batch = missing;
  }
  for (const name of batch) {
    const folder = folders.get(name)?.[0]; // ponytail: first folder wins when a repo ships the same name twice
    if (folder === undefined) throw new Error(`${name} isn't in ${source}`);
    results.push(...(await add(source, { project, folder, skills: [name] })));
  }
  return results;
}

/** Removes from Claude Code only; copies other agents use (and their lock entry) stay put. */
export async function remove(names: string[], forget = false) {
  if (!names.length || !names.every((n) => NAME.test(n))) throw new Error("Bad skill names");
  // only skills npx skills actually tracks or that exist in ~/.claude/skills — never arbitrary input
  const known = lockEntries();
  const unknown = names.filter((n) => !known[n] && !inClaude(n));
  if (unknown.length) throw new Error(`Not installed: ${unknown.join(", ")}`);
  // forget = every agent + the lock entry, for skills that no longer exist upstream
  await runSkills(["remove", ...names, "-g", "-y", ...(forget ? [] : ["-a", "claude-code"])]);
}

/** Reinstall one locked skill from where it lives now (its locked folder, or where it moved to). */
export async function update(name: string, movedTo?: string) {
  const e = lockEntries()[name];
  if (!e?.skillPath) throw new Error(`${name} is not tracked by npx skills`);
  return add(e.ref ? `${e.source}#${e.ref}` : e.source, { folder: movedTo ?? folderOf(e.skillPath), skills: [name] });
}

// Your source list = repos the npx lock knows about + ones you pinned, minus ones you hid. Stored next to nothing else.
const SOURCES_FILE = join(homedir(), ".config/skill-manager/sources.json");
type SourcePrefs = { pinned: string[]; hidden: string[] };
const readPrefs = (): SourcePrefs => ({ pinned: [], hidden: [], ...(existsSync(SOURCES_FILE) ? JSON.parse(readFileSync(SOURCES_FILE, "utf8")) : {}) });
function writePrefs(prefs: SourcePrefs) {
  mkdirSync(dirname(SOURCES_FILE), { recursive: true });
  writeFileSync(SOURCES_FILE, JSON.stringify(prefs, null, 2));
}
const REPO = /^[\w.-]+\/[\w.-]+$/;

export async function pinSource(repo: string) {
  if (!REPO.test(repo)) throw new Error("Expected owner/repo");
  if (!skillFolders(await tree(repo)).length) throw new Error(`${repo} doesn't publish any skills`);
  const prefs = readPrefs();
  writePrefs({ pinned: [...new Set([...prefs.pinned, repo])], hidden: prefs.hidden.filter((r) => r !== repo) });
}

export function hideSource(repo: string) {
  if (!REPO.test(repo)) throw new Error("Expected owner/repo");
  const prefs = readPrefs();
  writePrefs({ pinned: prefs.pinned.filter((r) => r !== repo), hidden: [...new Set([...prefs.hidden, repo])] });
}

export async function sources() {
  const prefs = readPrefs();
  const groups = Map.groupBy(Object.entries(lockEntries()), ([, e]) => e.source);
  const repos = [...new Set([...groups.keys(), ...prefs.pinned])].filter((r) => !prefs.hidden.includes(r));
  return Promise.all(
    repos.map(async (source) => {
      const list = groups.get(source) ?? [];
      // how many skills the repo offers right now ("using 3 of 11"); null if GitHub can't be reached
      const available = await tree(source).then((t) => skillFolders(t).length, () => null);
      return { source, tracked: list.length, inClaude: list.filter(([n]) => inClaude(n)).length, available, pinned: prefs.pinned.includes(source) };
    }),
  ).then((r) => r.sort((a, b) => a.source.localeCompare(b.source)));
}

/** Names of the skills Claude Code has from this source (to uninstall a whole source). */
export const skillsFrom = (source: string) => Object.entries(lockEntries()).filter(([n, e]) => e.source === source && inClaude(n)).map(([n]) => n);

if (import.meta.main) {
  console.assert(folderOf("skills/cmux/SKILL.md") === "skills/cmux" && folderOf("SKILL.md") === "", "folderOf broke");
  const r = await checkUpdates();
  console.log(Object.fromEntries(Map.groupBy(r, (x) => `${x.status}${x.inClaude ? "" : " (other agents)"}`).entries().map(([k, v]) => [k, v.length])));
  console.log(r.filter((x) => x.status === "moved").slice(0, 3));
}
