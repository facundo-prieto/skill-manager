import { homedir } from "node:os";
import { join } from "node:path";
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { scan } from "./scan";
import { lockEntries, update } from "./npx";
import type { Progress } from "./jobs";

const H = homedir();

// Global skill folders per agent (paths as the skills CLI 1.7 and each tool document them)
export const AGENTS = [
  { id: "claude", label: "Claude Code", dir: join(H, ".claude/skills") },
  { id: "shared", label: "Shared (Codex, Pi, Warp, Zed)", dir: join(H, ".agents/skills") },
  { id: "codex", label: "Codex", dir: join(H, ".codex/skills") },
  { id: "cursor", label: "Cursor", dir: join(H, ".cursor/skills") },
  { id: "gemini", label: "Gemini CLI", dir: join(H, ".gemini/skills") },
  { id: "pi", label: "Pi", dir: join(H, ".pi/agent/skills") },
  { id: "factory", label: "Factory", dir: join(H, ".factory/skills") },
  { id: "augment", label: "Augment", dir: join(H, ".augment/skills") },
  { id: "home", label: "~/skills (no agent reads it)", dir: join(H, "skills") },
] as const;

export type AgentId = (typeof AGENTS)[number]["id"];
export type AgentCopy = { path: string; hash: string; modified: number; link?: string; viaPlugin?: string };
export type AgentRow = { name: string; copies: Partial<Record<AgentId, AgentCopy>>; npxSource?: string };

const hashOf = (file: string) => createHash("sha1").update(readFileSync(file)).digest("hex").slice(0, 10);

/** Every skill name across every agent's folder, with which agents have it and whether the copies match. */
export function agentMatrix(): { agents: { id: AgentId; label: string; dir: string; count: number }[]; rows: AgentRow[] } {
  const present = AGENTS.filter((a) => existsSync(a.dir));
  const rows = new Map<string, AgentRow>();
  const locks = lockEntries();
  const row = (name: string) => rows.get(name) ?? rows.set(name, { name, copies: {}, npxSource: locks[name]?.source }).get(name)!;

  for (const agent of present) {
    for (const name of readdirSync(agent.dir)) {
      const dir = join(agent.dir, name);
      const md = join(dir, "SKILL.md");
      if (name.startsWith(".") || !existsSync(md)) continue;
      const link = lstatSync(dir).isSymbolicLink() ? readlinkSync(dir) : undefined;
      row(name).copies[agent.id] = { path: md, hash: hashOf(md), modified: statSync(md).mtimeMs, link };
    }
  }
  // Claude also gets skills from plugins: count them so parity reflects what Claude really has
  for (const s of scan()) {
    if (!s.plugin) continue;
    const name = s.name.split(":")[1]!;
    if (!row(name).copies.claude) row(name).copies.claude = { path: s.path, hash: hashOf(s.path), modified: statSync(s.path).mtimeMs, viaPlugin: s.plugin };
  }
  return {
    agents: present.map((a) => ({ id: a.id, label: a.label, dir: a.dir.replace(H, "~"), count: [...rows.values()].filter((r) => r.copies[a.id]).length })),
    rows: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const NAME = /^\w[\w.-]*$/;

/** Copy skill folders between agents. Never overwrites: an existing copy at the destination is reported, not replaced. */
export function copySkills(from: AgentId, to: AgentId, names: string[]) {
  const src = AGENTS.find((a) => a.id === from);
  const dst = AGENTS.find((a) => a.id === to);
  if (!src || !dst || from === to) throw new Error("Pick two different agents");
  if (!names.length || !names.every((n) => NAME.test(n))) throw new Error("Bad skill names");
  const copied: string[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    const target = join(dst.dir, name);
    if (!existsSync(join(src.dir, name, "SKILL.md"))) throw new Error(`${src.label} has no ${name}`);
    if (existsSync(target)) {
      skipped.push(name);
      continue;
    }
    // dereference: shared-dir installs are symlinks, the destination gets real files
    cpSync(join(src.dir, name), target, { recursive: true, dereference: true });
    copied.push(name);
  }
  return { copied, skipped };
}

if (import.meta.main) {
  const { agents, rows } = agentMatrix();
  console.log(agents);
  const missing = rows.filter((r) => !r.copies.claude && Object.keys(r.copies).length);
  console.log(`${rows.length} skills, ${missing.length} not in Claude:`, missing.slice(0, 15).map((r) => `${r.name}[${Object.keys(r.copies)}]`).join(" "));
}

/**
 * Bring skills back to Claude Code the best available way: npx-tracked ones are reinstalled from their repo
 * (latest version, stays updatable); the rest are copied from whichever agent has the most recently edited copy.
 */
export async function addToClaude(names: string[], p?: Progress) {
  if (!names.length || !names.every((n) => NAME.test(n))) throw new Error("Bad skill names");
  const { rows } = agentMatrix();
  const locks = lockEntries();
  const results: { name: string; how: string; ok: boolean; error?: string }[] = [];
  p?.setTotal(names.length);
  for (const name of names) {
    p?.step(`Adding ${name}`);
    const r = rows.find((x) => x.name === name);
    if (r?.copies.claude) {
      results.push({ name, how: "already in Claude Code", ok: true });
      continue;
    }
    try {
      const reinstall = locks[name] && (await update(name).then(() => true, () => false)); // fails when the repo dropped it
      if (reinstall) {
        results.push({ name, how: `reinstalled from ${locks[name]!.source}`, ok: true });
      } else {
        const newest = Object.entries(r?.copies ?? {}).sort(([, a], [, b]) => b.modified - a.modified)[0];
        if (!newest) throw new Error("no copy in any agent");
        copySkills(newest[0] as AgentId, "claude", [name]);
        results.push({ name, how: `copied from ${AGENTS.find((a) => a.id === newest[0])!.label}`, ok: true });
      }
    } catch (e) {
      results.push({ name, how: "failed", ok: false, error: (e as Error).message });
    }
  }
  return results;
}
