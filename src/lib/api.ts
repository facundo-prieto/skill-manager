import type { Repo, Skill, Verify } from "@/server/scan";
import type { Usage } from "@/server/usage";
import type { Archived } from "@/server/archive";
import type { RepoSkill, UpdateStatus } from "@/server/npx";
import type { Namespace } from "@/server/satl";
import type { Finding, Fix } from "@/server/doctor";
import type { AgentCopy, AgentId, AgentRow } from "@/server/agents";
import type { Plugin } from "@/server/plugins";
import type { Location } from "@/server/locations";

export type { Repo, Skill, Usage, Archived, UpdateStatus, Namespace, RepoSkill, Verify, Finding, Fix, AgentCopy, AgentId, AgentRow, Plugin, Location };
export type AgentMatrix = { agents: { id: AgentId; label: string; dir: string; count: number }[]; rows: AgentRow[] };
export type SourceSummary = { source: string; tracked: number; inClaude: number; available: number | null; pinned: boolean };
export type SatlStatus = { initialized: boolean; includes: string[]; excludes: string[]; generatedAt?: string; changed: string[]; clone: { path: string; behind: number } };
export type SearchHit = { id: string; source: string; name: string; installs: number };

async function call<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok || body?.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const get = <T,>(url: string) => fetch(url).then((r) => call<T>(r));
export const post = <T = { ok: true },>(url: string, body: object) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => call<T>(r));

// Toggle key: user/project skills by name, plugin skills by plugin id (Claude Code can't hide them individually)
export const keyOf = (s: Skill) => s.plugin ?? s.name;
export const uses = (u?: Usage) => (u ? u.model + u.user : 0);
export const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const sum = (list: Skill[], k: "listingTokens" | "bodyTokens") => list.reduce((t, s) => t + s[k], 0);

export function ago(ms: number) {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  return days === 0 ? "today" : days === 1 ? "yesterday" : days < 60 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`;
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The launch command: skillOverrides hides user/project skills, enabledPlugins hides whole plugins (verified on 2.1.300). */
export function buildCommand(skills: Skill[], off: Set<string>, project?: string) {
  const settings: Record<string, object> = {};
  const skillsOff = [...new Set(skills.filter((s) => !s.plugin && off.has(s.name)).map((s) => s.name))];
  const pluginsOff = [...new Set(skills.filter((s) => s.plugin && off.has(s.plugin)).map((s) => s.plugin!))];
  if (skillsOff.length) settings.skillOverrides = Object.fromEntries(skillsOff.map((n) => [n, "off"]));
  if (pluginsOff.length) settings.enabledPlugins = Object.fromEntries(pluginsOff.map((p) => [p, false]));
  const claude = Object.keys(settings).length ? `claude --settings ${shellQuote(JSON.stringify(settings))}` : "claude";
  return project ? `cd ${shellQuote(project)} && ${claude}` : claude;
}
