import { homedir } from "node:os";
import { join, basename } from "node:path";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { lockEntries } from "./npx";
import { frontmatter } from "./frontmatter";
import { abcRepos, readConfig } from "./config";

const CLAUDE = join(homedir(), ".claude");

/** Where a skill came from, so sets installed together (e.g. all of mattpocock/skills) can be grouped. */
export type Origin =
  | { kind: "github"; label: string; url: string } // npx skills (lock file)
  | { kind: "satl"; label: string } // satl install
  | { kind: "plugin"; label: string } // Claude Code plugin
  | { kind: "link"; label: string } // symlink to somewhere on disk
  | { kind: "local"; label: string }; // a plain folder: written by you or copied by hand

export type Skill = {
  name: string; // name as Claude lists it (plugin skills: "plugin:skill")
  description: string;
  scope: "global" | "project" | "plugin";
  plugin?: string; // "name@marketplace" — plugin skills can only be toggled per plugin
  path: string;
  origin: Origin;
  listingTokens: number; // always in context: the "name: description" line Claude sees
  bodyTokens: number; // loaded only when the skill is invoked
  paths?: string[]; // conditional skill: only offered once Claude touches matching files
  modelOnly?: boolean; // user-invocable: false — Claude can use it, but there's no /command (and init events omit it)
};

// ponytail: chars/4 estimate, swap for the count_tokens API if exact numbers matter
const tokens = (text: string) => Math.ceil(text.length / 4);

const readJson = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});

const frontmatterOf = (file: string) => frontmatter(readFileSync(file, "utf8"));

const SATL_SCOPE: Record<string, string> = { g: "global", r: "repo", t: "team", u: "user" };

function originOf(dir: string, locks: Record<string, { source: string; sourceUrl?: string }>): Origin {
  const name = basename(dir);
  // satl install names dirs satl-{id}-skill-{g|r|t|u}-{namespace}
  const satl = name.match(/^satl-.+-skill-([grtu])-(.+)$/);
  if (satl) return { kind: "satl", label: `SATL · ${SATL_SCOPE[satl[1]!]}/${satl[2]}` };
  const lock = locks[name];
  if (lock) return { kind: "github", label: lock.source, url: `https://github.com/${lock.source}` };
  if (lstatSync(dir).isSymbolicLink()) return { kind: "link", label: readlinkSync(dir).replace(homedir(), "~") };
  return { kind: "local", label: "Local" };
}

function skill(path: string, scope: Skill["scope"], origin: Origin, prefix?: string, fallbackName?: string): Skill {
  const fm = frontmatterOf(path);
  // plugin skills are listed as plugin:<folder name> — Claude Code ignores their frontmatter name
  const name = prefix ? `${prefix}:${fallbackName}` : String(fm.name ?? fallbackName);
  const description = String(fm.description ?? "");
  return {
    name,
    description,
    scope,
    path,
    origin,
    // disable-model-invocation and path-gated skills aren't in the startup listing
    listingTokens: fm["disable-model-invocation"] === true || fm.paths ? 0 : tokens(`- ${name}: ${description}`),
    bodyTokens: tokens(readFileSync(path, "utf8")),
    ...(Array.isArray(fm.paths) && { paths: fm.paths.map(String) }),
    ...(fm["user-invocable"] === false && { modelOnly: true }),
  };
}

/** Legacy .claude/commands/*.md — Claude lists them alongside skills. */
function scanCommands(dir: string, scope: "global" | "project"): Skill[] {
  return children(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => skill(f, scope, { kind: "local", label: "Local" }, undefined, basename(f, ".md")));
}

function scanDir(dir: string, scope: "global" | "project", locks: Record<string, any>): Skill[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => !d.startsWith(".") && existsSync(join(dir, d, "SKILL.md")))
    .map((d) => skill(join(dir, d, "SKILL.md"), scope, originOf(join(dir, d), locks), undefined, d));
}

const children = (dir: string) => (existsSync(dir) ? readdirSync(dir).map((d) => join(dir, d)) : []);
const manifestPaths = (root: string, value: unknown) =>
  Array.isArray(value) ? value.map((p) => join(root, String(p))) : typeof value === "string" ? [join(root, value)] : null;
// a manifest path is either a skill dir (has SKILL.md) or a dir of skill dirs ("skills": "./skills/")
const expandSkillDirs = (paths: string[]) => paths.flatMap((p) => (existsSync(join(p, "SKILL.md")) ? [p] : children(p)));

export function scanPlugin(id: string, root: string): Skill[] {
  const prefix = id.split("@")[0]!;
  const origin: Origin = { kind: "plugin", label: id };
  const manifest = readJson(join(root, ".claude-plugin/plugin.json"));
  // plugin.json may list skill dirs explicitly (e.g. mattpocock's skills/engineering/*); otherwise skills/*/
  const skillDirs = expandSkillDirs(manifestPaths(root, manifest.skills) ?? [join(root, "skills")]).filter((d) => existsSync(join(d, "SKILL.md")));
  // legacy plugin commands are listed for the model too
  const commandFiles = (manifestPaths(root, manifest.commands) ?? children(join(root, "commands"))).filter((f) => f.endsWith(".md") && existsSync(f));
  return [
    ...skillDirs.map((d) => skill(join(d, "SKILL.md"), "plugin", origin, prefix, basename(d))),
    ...commandFiles.map((f) => skill(f, "plugin", origin, prefix, basename(f, ".md"))),
  ].map((s) => ({ ...s, plugin: id }));
}

type PluginInfo = { id: string; enabled: boolean; projectEnabled?: boolean; installPath: string };
const pluginCache = new Map<string, { at: number; list: PluginInfo[] }>();

/** Ask Claude Code itself which plugins are on: settings files alone miss defaults (mattpocock-skills was enabled with no settings entry). */
export function enabledPlugins(project?: string): PluginInfo[] {
  const key = project ?? "~";
  const hit = pluginCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.list;
  const res = Bun.spawnSync(["claude", "plugin", "list", "--json"], { cwd: project ?? homedir() });
  const list = res.success
    ? (JSON.parse(res.stdout.toString()) as PluginInfo[])
        // @skills-dir "plugins" are plain skill folders with a manifest: Claude lists them as normal skills
        .filter((p) => (p.enabled || p.projectEnabled) && !p.id.endsWith("@skills-dir"))
    : [];
  pluginCache.set(key, { at: Date.now(), list });
  return list;
}

export function scan(project?: string): Skill[] {
  // ponytail: synced claude.ai skills (anthropic-skills:*) skipped — no known per-session switch for them
  return [
    ...scanDir(join(CLAUDE, "skills"), "global", lockEntries()),
    ...scanCommands(join(CLAUDE, "commands"), "global"),
    ...(project ? scanCommands(join(project, ".claude/commands"), "project") : []),
    ...(project ? scanDir(join(project, ".claude/skills"), "project", readJson(join(project, "skills-lock.json")).skills ?? {}) : []),
    ...enabledPlugins(project).flatMap((p) => scanPlugin(p.id, p.installPath)),
  ];
}

export type Repo = { name: string; path: string; skills: number; satl: boolean; manual: boolean };

/** Repos to scan: the ones `abc` (AuditBoard dev CLI) manages, plus any you added by hand in Settings or the picker. */
export function repos(): Repo[] {
  const fromAbc = Object.entries(abcRepos()).map(([name, path]) => ({ name, path, manual: false }));
  const manual = readConfig().repos.filter((p) => !fromAbc.some((r) => r.path === p)).map((path) => ({ name: basename(path), path, manual: true }));
  return [...fromAbc, ...manual]
    .filter(({ path }) => existsSync(path))
    .map(({ name, path, manual }) => {
      const skills = join(path, ".claude/skills");
      return {
        name,
        path,
        skills: existsSync(skills) ? readdirSync(skills).filter((d) => existsSync(join(skills, d, "SKILL.md"))).length : 0,
        satl: existsSync(join(path, "satl.json")),
        manual,
      };
    })
    .sort((a, b) => b.skills - a.skills);
}

if (import.meta.main) {
  const s = scan(process.argv[2] ?? process.cwd()); // bun src/server/scan.ts [repo]
  const byOrigin = Map.groupBy(s, (x) => `${x.origin.kind}:${x.origin.label}`);
  console.log([...byOrigin].map(([k, v]) => `${k} (${v.length})`).join("\n"));
  console.log(repos());
}

export type Verify = { claudeOnly: { builtIn: string[]; claudeAi: string[]; mcp: string[]; other: string[] }; managerOnly: string[] };

/**
 * Ground truth: what a real `claude` session in this repo lists at startup (one tiny Haiku turn).
 * Anything listed here but not scanned is either Claude Code's own command set or something this tool misses.
 */
export async function verify(project?: string): Promise<Verify> {
  const proc = Bun.spawn(["claude", "-p", "--model", "haiku", "--max-turns", "1", "--output-format", "stream-json", "--verbose", "--", "hi"], {
    cwd: project ?? homedir(),
    stderr: "ignore",
  });
  let init: { skills: string[]; slash_commands: string[] } | undefined;
  for (const line of (await new Response(proc.stdout).text()).split("\n")) {
    if (line.includes('"subtype":"init"')) init = JSON.parse(line);
  }
  if (!init) throw new Error("Couldn't read the session's init event from claude -p");
  const scanned = scan(project);
  const mine = new Set(scanned.map((s) => s.name));
  const listed = new Set([...init.skills, ...init.slash_commands]);
  const claudeOnly = [...listed].filter((n) => !mine.has(n)).sort();
  const isBuiltIn = (n: string) => !n.includes(":") && !n.startsWith("mcp__"); // ponytail: no list of built-ins exists, so "unprefixed and not on disk"
  return {
    claudeOnly: {
      claudeAi: claudeOnly.filter((n) => n.startsWith("anthropic-skills:")),
      mcp: claudeOnly.filter((n) => n.startsWith("mcp__")),
      builtIn: claudeOnly.filter(isBuiltIn),
      other: claudeOnly.filter((n) => n.includes(":") && !n.startsWith("anthropic-skills:") && !n.startsWith("mcp__")),
    },
    // conditional (paths:) skills only appear once matching files are touched, so they're expected here
    // also expected: model-only skills (user-invocable: false) never appear in the init lists, though Claude uses them
    managerOnly: scanned.filter((s) => !listed.has(s.name) && !s.paths && !s.modelOnly).map((s) => s.name),
  };
}

/** Plugins whose manifest points at a GitHub repo — those can be managed skill-by-skill with npx skills instead. */
export function pluginRepos(project?: string) {
  return enabledPlugins(project).flatMap((p) => {
    const repo = String(readJson(join(p.installPath, ".claude-plugin/plugin.json")).repository ?? "").match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1];
    return repo ? [{ id: p.id, repo }] : [];
  });
}
