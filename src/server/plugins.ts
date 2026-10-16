import { homedir } from "node:os";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanPlugin } from "./scan";
import { frontmatter } from "./frontmatter";
import type { Progress } from "./jobs";

export type Plugin = {
  id: string;
  version: string;
  scope: string;
  enabled: boolean;
  projectEnabled: boolean;
  description: string;
  repo?: string; // owner/repo when the manifest points at GitHub
  skills: { name: string; description: string; path: string }[]; // what it contributes (plugin:folder), on or off
  alsoLoose: string[]; // those same skills installed loose in ~/.claude/skills (e.g. after switching to npx)
  components: { skills: number; commands: number; agents: number; hooks: number; mcp: number; lsp: number }; // all zero = loads nothing
  installedAt?: string;
};

const marketplaces = new Map<string, any[]>();
function marketplaceEntry(id: string) {
  const [name, market] = id.split("@") as [string, string];
  if (!marketplaces.has(market)) {
    const f = join(homedir(), ".claude/plugins/marketplaces", market, ".claude-plugin/marketplace.json");
    marketplaces.set(market, existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).plugins ?? []) : []);
  }
  return marketplaces.get(market)!.find((e) => e.name === name) ?? {};
}

const count = (dir: string, ext = ".md") => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)).length : 0);
const keys = (v: unknown) => (v && typeof v === "object" ? Object.keys(v as object).length : v ? 1 : 0);

/** What a plugin contributes besides skills — mirrors the inventory `claude plugin details` prints. */
function inventory(root: string, manifest: any, skills: { path: string }[]) {
  const mcpFile = join(root, ".mcp.json");
  const hooksFile = join(root, "hooks/hooks.json");
  return {
    skills: skills.filter((s) => s.path.endsWith("SKILL.md")).length,
    commands: skills.filter((s) => !s.path.endsWith("SKILL.md")).length,
    agents: Array.isArray(manifest.agents) ? manifest.agents.length : count(join(root, "agents")),
    hooks: manifest.hooks ? keys(manifest.hooks) : existsSync(hooksFile) ? keys(JSON.parse(readFileSync(hooksFile, "utf8")).hooks) : 0,
    mcp: manifest.mcpServers ? keys(manifest.mcpServers) : existsSync(mcpFile) ? keys(JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers) : 0,
    lsp: keys(manifest.lspServers),
  };
}

type Raw = { id: string; version: string; scope: string; enabled: boolean; projectEnabled?: boolean; installPath: string; installedAt?: string };

/** Every installed plugin, on or off, straight from `claude plugin list --json`. */
export function listPlugins(project?: string): Plugin[] {
  const res = Bun.spawnSync(["claude", "plugin", "list", "--json"], { cwd: project ?? homedir() });
  if (!res.success) throw new Error(`claude plugin list failed: ${res.stderr.toString().trim()}`);
  return (JSON.parse(res.stdout.toString()) as Raw[]).map((p) => {
    const manifestPath = join(p.installPath, ".claude-plugin/plugin.json");
    // Claude merges the marketplace entry with plugin.json (LSP plugins declare their server only in the marketplace)
    const manifest = { ...marketplaceEntry(p.id), ...(existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {}) };
    const found = existsSync(p.installPath) && !p.id.endsWith("@skills-dir") ? scanPlugin(p.id, p.installPath) : [];
    const skills = found.map((s) => ({ name: s.name, description: s.description, path: s.path }));
    // a loose copy only counts as "the same skill" if its description matches (code-review exists in two unrelated places)
    const loose = (name: string) => join(homedir(), ".claude/skills", name, "SKILL.md");
    const sameAsLoose = (s: (typeof found)[number]) => {
      const f = loose(s.name.split(":")[1]!);
      return existsSync(f) && String(frontmatter(readFileSync(f, "utf8")).description ?? "") === s.description;
    };
    return {
      id: p.id,
      version: p.version,
      scope: p.scope,
      enabled: p.enabled,
      projectEnabled: !!p.projectEnabled,
      description: String(manifest.description ?? ""),
      repo: String(manifest.repository?.url ?? manifest.repository ?? "").match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1],
      skills,
      alsoLoose: found.filter(sameAsLoose).map((s) => s.name.split(":")[1]!),
      installedAt: p.installedAt,
      components: inventory(p.installPath, manifest, found),
    };
  });
}

const ID = /^[\w.-]+@[\w.-]+$/;
const ACTIONS = ["enable", "disable", "uninstall"] as const;

export async function pluginAction(id: string, action: (typeof ACTIONS)[number], p?: Progress) {
  if (!ID.test(id) || !ACTIONS.includes(action)) throw new Error("Bad plugin id or action");
  p?.step(`claude plugin ${action} ${id}`);
  const res = Bun.spawnSync(["claude", "plugin", action, id, "--json"]);
  const out = (res.stdout.toString() + res.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, "").trim();
  // asking for the state it's already in counts as success
  if (!res.success && !/already (enabled|disabled)/i.test(out)) throw new Error(out.split("\n").at(-1) || `${action} failed`);
}
