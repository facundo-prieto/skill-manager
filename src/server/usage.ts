import { homedir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { statSync } from "node:fs";

export type Usage = { model: number; user: number; lastUsed: number };

const PROJECTS = join(homedir(), ".claude/projects");
// Claude picking a skill vs you typing /skill (the latter also matches built-ins like /model; the UI only joins known skills)
const MODEL = /"name":"Skill","input":\{"skill":"([^"]+)"/g;
const USER = /<command-name>\/([^<\s]+)<\/command-name>/g;

// per-transcript cache keyed by mtime: the first scan reads ~all history, later ones only changed sessions
const cache = new Map<string, { mtime: number; model: string[]; user: string[] }>();

export async function usage(): Promise<Record<string, Usage>> {
  const totals: Record<string, Usage> = {};
  for await (const rel of new Glob("**/*.jsonl").scan(PROJECTS)) {
    const path = join(PROJECTS, rel);
    const mtime = statSync(path).mtimeMs;
    let hit = cache.get(path);
    if (hit?.mtime !== mtime) {
      const text = await Bun.file(path).text();
      hit = { mtime, model: [...text.matchAll(MODEL)].map((m) => m[1]!), user: [...text.matchAll(USER)].map((m) => m[1]!) };
      cache.set(path, hit);
    }
    const { model, user } = hit;
    for (const [kind, names] of [["model", model], ["user", user]] as const)
      for (const name of names) {
        const t = (totals[name] ??= { model: 0, user: 0, lastUsed: 0 });
        t[kind]++;
        t.lastUsed = Math.max(t.lastUsed, mtime); // ponytail: session mtime ≈ last use; parse timestamps if precision matters
      }
  }
  return totals;
}

if (import.meta.main) {
  // self-check: both invocation shapes are counted
  const line = `{"type":"tool_use","name":"Skill","input":{"skill":"demo"}} <command-name>/demo</command-name>`;
  console.assert([...line.matchAll(MODEL)][0]?.[1] === "demo" && [...line.matchAll(USER)][0]?.[1] === "demo", "regex broke");
  const top = Object.entries(await usage()).sort((a, b) => b[1].model + b[1].user - a[1].model - a[1].user);
  console.log(top.slice(0, 10));
}
