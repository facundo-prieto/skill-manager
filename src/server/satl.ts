import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { satlRepo } from "./config";

// SATL has no JSON listing (only `satl commands --json`), so the catalog is read straight from the KB files —
// the same knowledge-base/<scope>/<ns>/skills/<id>/SKILL.md layout the CLI's traverseKB walks.
// where the clone lives is detected (or set in Settings) on every call, so changing it needs no restart
const repo = () => satlRepo().path ?? "";
const kb = () => join(repo(), "knowledge-base");
function needRepo() {
  if (!repo()) throw new Error("SATL knowledge base not found. Set the path to your auditboard-satl clone in Settings.");
  return repo();
}
const KINDS = ["skills", "rules", "commands", "agents"] as const;

type SatlSkill = { id: string; name: string; description: string; path: string };
export type Namespace = { token: string; skills: SatlSkill[]; counts: Record<string, number> };

const ls = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((d) => !d.startsWith(".")) : []);

function satlMeta(file: string): { name?: string; description?: string } {
  const m = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/);
  try {
    return (m && (Bun.YAML.parse(m[1]!) as any)?.satl) ?? {};
  } catch {
    return {};
  }
}

export function catalog(): Namespace[] {
  return (["team", "user"] as const).flatMap((scope) =>
    ls(join(kb(), scope)).sort().map((ns) => {
      const dir = join(kb(), scope, ns);
      const skills = ls(join(dir, "skills"))
        .filter((id) => existsSync(join(dir, "skills", id, "SKILL.md")))
        .map((id) => ({ id, path: join(dir, "skills", id, "SKILL.md"), ...satlMeta(join(dir, "skills", id, "SKILL.md")) }))
        .map((s) => ({ id: s.id, path: s.path, name: s.name ?? s.id, description: s.description ?? "" }));
      const counts = Object.fromEntries(KINDS.map((k) => [k, ls(join(dir, k)).length]));
      return { token: `${scope}/${ns}`, skills, counts };
    }),
  );
}

// async on purpose: satl install can take seconds, and a sync spawn would freeze every other request meanwhile
const run = async (cmd: string[], cwd: string) => {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, SATL_REPO_PATH: repo() }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error((out + err).trim().split("\n").slice(-8).join("\n"));
  return out + err;
};

/** What a repo has selected today, plus how far the local SATL clone is behind its upstream. */
export async function status(project: string, fetch = false) {
  const REPO = needRepo();
  if (fetch) await run(["git", "fetch", "--quiet"], REPO); // refs only, never touches the working tree
  const [ahead, behind] = (await run(["git", "rev-list", "--left-right", "--count", "HEAD...@{upstream}"], REPO)).trim().split(/\s+/).map(Number);
  const read = (f: string) => (existsSync(join(project, f)) ? JSON.parse(readFileSync(join(project, f), "utf8")) : null);
  const config = read(".satl/config.json");
  const generatedAt: string | undefined = read(".satl/manifest.json")?.generatedAt;
  // a team "changed" if upstream has commits touching its folder, or the clone got commits there after this repo's last install
  const changed: string[] = [];
  for (const token of ((config?.includes ?? []) as string[]).filter((t) => t.split("/").length === 2)) {
    const dir = `knowledge-base/${token}`;
    const upstream = (await run(["git", "diff", "--name-only", "HEAD..@{upstream}", "--", dir], REPO).catch(() => "")).trim();
    const sinceInstall = generatedAt ? (await run(["git", "log", `--since=${generatedAt}`, "--format=%h", "--", dir], REPO).catch(() => "")).trim() : "";
    if (upstream || sinceInstall) changed.push(token);
  }
  return {
    initialized: existsSync(join(project, "satl.json")),
    includes: (config?.includes ?? []) as string[],
    excludes: (config?.excludes ?? []) as string[],
    generatedAt,
    changed,
    clone: { path: REPO, ahead, behind },
  };
}

// team, team/<ns>, or one skill inside a namespace: team/<ns>/skills/<id>
const TOKEN = /^(team|user)(\/[\w.-]+(\/skills\/[\w.-]+)?)?$/;
const teamOf = (t: string) => t.split("/").slice(0, 2).join("/");

/**
 * The CLI only ever adds tokens, so a skill you excluded and then picked again would stay behind as its own include
 * (and outlive its team). Settle per-skill picks in .satl/config.json first; the CLI gets only what's left.
 */
function settleSkillPicks(project: string, include: string[], exclude: string[]) {
  const file = join(project, ".satl/config.json");
  if (!existsSync(file)) return { include, exclude };
  const config = JSON.parse(readFileSync(file, "utf8"));
  let inc: string[] = config.includes ?? [];
  let exc: string[] = config.excludes ?? [];
  const teamOn = (t: string) => (inc.includes(teamOf(t)) || include.includes(teamOf(t))) && !exclude.includes(teamOf(t));
  for (const t of include.filter((t) => t.includes("/skills/") && teamOn(t))) exc = exc.filter((x) => x !== t); // the team covers it
  for (const t of exclude.filter((t) => t.split("/").length === 2)) inc = inc.filter((x) => !x.startsWith(`${t}/`)), (exc = exc.filter((x) => !x.startsWith(`${t}/`))); // team off: forget its per-skill picks
  writeFileSync(file, JSON.stringify({ ...config, includes: inc, excludes: exc }, null, 2) + "\n");
  return { include: include.filter((t) => !(t.includes("/skills/") && teamOn(t))), exclude };
}

export async function install(project: string, include: string[], exclude: string[], dryRun = false) {
  if (![...include, ...exclude].every((t) => TOKEN.test(t))) throw new Error("Tokens must look like team/<ns>, user/<ns> or team/<ns>/skills/<id>");
  if (!existsSync(join(project, "satl.json"))) throw new Error("This repo has no satl.json — run `satl init` there first");
  if (!dryRun) ({ include, exclude } = settleSkillPicks(project, include, exclude));
  const args = ["satl", "install", "--skip-wizard", "--claude", ...(dryRun ? ["--dry-run"] : [])];
  // includes are additive in .satl/config.json, so deselecting needs an explicit exclude
  if (include.length) args.push("--include", include.join(","));
  if (exclude.length) args.push("--exclude", exclude.join(","));
  return run(args, project);
}

/** `satl sync` never pulls a non-~/.satl clone ("BYO"), so pull here first — only fast-forward, only when clean. */
export async function sync(project: string) {
  const REPO = needRepo();
  if ((await run(["git", "status", "--porcelain"], REPO)).trim()) throw new Error(`${REPO} has uncommitted changes; not pulling`);
  return (await run(["git", "pull", "--ff-only"], REPO)) + (await run(["satl", "sync"], project));
}

if (import.meta.main) {
  const { mkdtempSync, mkdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(require("node:os").tmpdir(), "satl-"));
  mkdirSync(join(dir, ".satl"));
  const cfg = () => JSON.parse(readFileSync(join(dir, ".satl/config.json"), "utf8"));
  writeFileSync(join(dir, ".satl/config.json"), JSON.stringify({ includes: ["team/a", "team/b/skills/y"], excludes: ["team/a/skills/x"] }));
  // re-picking a skill of an installed team just drops its exclude; nothing left for the CLI
  console.assert(settleSkillPicks(dir, ["team/a/skills/x"], []).include.length === 0 && cfg().excludes.length === 0, "re-pick broke");
  // turning a team off forgets its per-skill picks
  settleSkillPicks(dir, [], ["team/b"]);
  console.assert(!cfg().includes.includes("team/b/skills/y"), "team-off cleanup broke");
  console.log("satl ok");
}
