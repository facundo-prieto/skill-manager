import { homedir } from "node:os";
import { basename, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { enabledPlugins } from "./scan";

const H = homedir();
const tilde = (p: string) => p.replace(H, "~");
const json = (p: string) => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  } catch {
    return {};
  }
};

/** MCP configs often embed credentials: never ship env/header values, and mask anything token-shaped in commands and URLs. */
function redact(text: string) {
  return text
    .replace(/((?:api[-_]?key|token|secret|password|auth)[=:\s]+)("?)[^\s"&]+/gi, "$1$2•••")
    .replace(/\b(sk-[\w-]{8,}|ghp_\w{20,}|gho_\w{20,}|xox[abp]-[\w-]+|AKIA\w{12,}|eyJ[\w-]{20,}\.[\w-]+\.[\w-]+)\b/g, "•••")
    .replace(/(Bearer\s+)\S+/gi, "$1•••");
}

export type McpLocation = { agent: string; scope: string; file: string; transport: "stdio" | "http" | "sse"; target: string; envKeys: string[] };
export type McpServer = { name: string; locations: McpLocation[] };

function mcpLocation(agent: string, scope: string, file: string, cfg: any): McpLocation {
  const url = cfg.url ?? cfg.serverUrl ?? cfg.httpUrl;
  const transport = url ? (cfg.type === "sse" ? "sse" : "http") : "stdio";
  const target = url ? redact(String(url)) : redact([cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(" "));
  return { agent, scope, file: tilde(file), transport, target, envKeys: Object.keys({ ...(cfg.env ?? {}), ...(cfg.headers ?? {}), ...(cfg.http_headers ?? {}) }) };
}

/** Every MCP server any agent on this machine is configured with, grouped by name. */
export function mcpServers(project?: string): McpServer[] {
  const found: [string, McpLocation][] = [];
  const add = (agent: string, scope: string, file: string, servers: Record<string, any> | undefined) => {
    for (const [name, cfg] of Object.entries(servers ?? {})) found.push([name, mcpLocation(agent, scope, file, cfg)]);
  };
  const claudeJson = join(H, ".claude.json");
  const cj = json(claudeJson);
  add("Claude Code", "user", claudeJson, cj.mcpServers);
  for (const [path, p] of Object.entries<any>(cj.projects ?? {})) if (p.mcpServers && (!project || path === project)) add("Claude Code", `local · ${basename(path)}`, claudeJson, p.mcpServers);
  if (project) add("Claude Code", "project", join(project, ".mcp.json"), json(join(project, ".mcp.json")).mcpServers);
  for (const p of enabledPlugins(project)) {
    const own = json(join(p.installPath, ".mcp.json")).mcpServers ?? json(join(p.installPath, ".claude-plugin/plugin.json")).mcpServers;
    if (typeof own === "object") add("Claude Code", `plugin · ${p.id.split("@")[0]}`, join(p.installPath, ".mcp.json"), own);
  }
  const codex = join(H, ".codex/config.toml");
  if (existsSync(codex)) {
    try {
      add("Codex", "user", codex, (Bun.TOML.parse(readFileSync(codex, "utf8")) as any).mcp_servers);
    } catch {
      /* unreadable config: skip rather than fail the whole list */
    }
  }
  add("Cursor", "user", join(H, ".cursor/mcp.json"), json(join(H, ".cursor/mcp.json")).mcpServers);
  add("Gemini CLI", "user", join(H, ".gemini/settings.json"), json(join(H, ".gemini/settings.json")).mcpServers);
  return [...Map.groupBy(found, ([n]) => n)].map(([name, l]) => ({ name, locations: l.map(([, loc]) => loc) })).sort((a, b) => a.name.localeCompare(b.name));
}

export type Hook = { agent: string; source: string; file: string; event: string; matcher?: string; command: string };
export type HookGroup = { owner: string; hooks: Hook[] };

/** Who installed a hook, guessed from its command (these are mostly tools wiring themselves into Claude Code). */
function ownerOf(h: Hook) {
  if (h.source.startsWith("plugin")) return h.source.replace("plugin · ", "Plugin: ");
  const c = h.command.toLowerCase();
  for (const [needle, label] of [
    [".orca", "Orca"],
    ["aide-tw", "AIDE"],
    ["superset", "Superset"],
    ["terax", "Terax"],
    ["warp", "Warp"],
    ["cmux", "cmux"],
    ["herdr", "herdr"],
    ["satl", "SATL"],
  ] as const)
    if (c.includes(needle)) return label;
  const first = h.command.trim().split(/\s+/)[0] ?? "";
  return basename(first.replace(/["']/g, "")) || "Other";
}

function collect(agent: string, source: string, file: string, hooks: Record<string, any[]> | undefined): Hook[] {
  return Object.entries(hooks ?? {}).flatMap(([event, entries]) =>
    (entries ?? []).flatMap((e: any) =>
      // Claude: [{ matcher, hooks: [{type, command}] }] · Cursor: [{ command }]
      (e.hooks ?? [e]).filter((x: any) => x.command).map((x: any) => ({ agent, source, file: tilde(file), event, matcher: e.matcher, command: redact(String(x.command)) })),
    ),
  );
}

export function hooks(project?: string): HookGroup[] {
  const all: Hook[] = [];
  for (const [scope, f] of [
    ["user", join(H, ".claude/settings.json")],
    ["user · local", join(H, ".claude/settings.local.json")],
    ...(project ? ([["project", join(project, ".claude/settings.json")], ["project · local", join(project, ".claude/settings.local.json")]] as const) : []),
  ] as const)
    all.push(...collect("Claude Code", scope, f, json(f).hooks));
  for (const p of enabledPlugins(project)) {
    const f = join(p.installPath, "hooks/hooks.json");
    const manifest = json(join(p.installPath, ".claude-plugin/plugin.json"));
    all.push(...collect("Claude Code", `plugin · ${p.id.split("@")[0]}`, f, typeof manifest.hooks === "object" ? manifest.hooks : json(f).hooks));
  }
  const cursor = join(H, ".cursor/hooks.json");
  all.push(...collect("Cursor", "user", cursor, json(cursor).hooks));
  return [...Map.groupBy(all, ownerOf)].map(([owner, hooks]) => ({ owner, hooks })).sort((a, b) => b.hooks.length - a.hooks.length);
}

if (import.meta.main) {
  console.assert(redact("x --api-key abc123") === "x --api-key •••" && redact("Bearer xyz") === "Bearer •••", "redact broke");
  console.log(mcpServers().map((m) => `${m.name}: ${m.locations.map((l) => `${l.agent}/${l.scope}`).join(", ")}`).join("\n"));
  console.log(hooks().map((g) => `${g.owner}: ${g.hooks.length} (${[...new Set(g.hooks.map((h) => h.event))].join(", ")})`).join("\n"));
}
