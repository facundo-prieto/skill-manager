import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { get } from "@/lib/api";
import type { HookGroup, McpServer } from "@/server/integrations";

const AGENTS = ["Claude Code", "Codex", "Cursor", "Gemini CLI"] as const;

function useList<T>(url: string) {
  const [data, setData] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void get<T[]>(url).then(setData, (e) => setError(e.message)), [url]);
  return { data, error };
}

function Toolbar({ query, setQuery, agent, setAgent, placeholder }: { query: string; setQuery: (q: string) => void; agent: string; setAgent: (a: string) => void; placeholder: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-56 flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-8" placeholder={placeholder} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <ToggleGroup type="single" variant="outline" value={agent} onValueChange={(v) => v && setAgent(v)}>
        <ToggleGroupItem value="all">All agents</ToggleGroupItem>
        {AGENTS.map((a) => (
          <ToggleGroupItem key={a} value={a}>
            {a.replace(" CLI", "")}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/** Every MCP server any agent is configured with — one row per name, expanding to each place it's defined. */
export function McpView({ project }: { project?: string }) {
  const { data, error } = useList<McpServer>(`/api/mcp?project=${encodeURIComponent(project ?? "")}`);
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(
    () => (data ?? []).filter((m) => m.name.toLowerCase().includes(query.toLowerCase())).filter((m) => agent === "all" || m.locations.some((l) => l.agent === agent)),
    [data, query, agent],
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Read from ~/.claude.json, each repo's .mcp.json, plugins, ~/.codex/config.toml, ~/.cursor/mcp.json and ~/.gemini/settings.json. Environment values and tokens are never shown.
      </p>
      <Toolbar query={query} setQuery={setQuery} agent={agent} setAgent={setAgent} placeholder="Search MCP servers" />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!data && !error ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No MCP servers</EmptyTitle>
            <EmptyDescription>Nothing matches this filter.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="divide-y overflow-hidden rounded-lg border bg-card">
          {rows.map((m) => {
            const isOpen = open === m.name;
            const transports = [...new Set(m.locations.map((l) => l.transport))];
            return (
              <div key={m.name}>
                <button className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-muted/30" onClick={() => setOpen(isOpen ? null : m.name)} aria-expanded={isOpen}>
                  <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[13px] font-medium">{m.name}</span>
                      {transports.map((t) => (
                        <Badge key={t} variant="outline">
                          {t}
                        </Badge>
                      ))}
                    </span>
                    <span className="line-clamp-1 font-mono text-xs text-muted-foreground">{m.locations[0]!.target}</span>
                  </span>
                  <span className="flex max-w-[50%] flex-wrap justify-end gap-1">
                    {m.locations.map((l, i) => (
                      <Badge key={i} variant="secondary" className="font-normal">
                        {l.agent === "Claude Code" ? l.scope : l.agent}
                      </Badge>
                    ))}
                  </span>
                </button>
                {isOpen && (
                  <div className="flex flex-col gap-2 bg-muted/20 px-11 pt-1 pb-3">
                    {m.locations.map((l, i) => (
                      <div key={i} className="flex flex-col gap-0.5 text-xs">
                        <span className="font-medium">
                          {l.agent} · {l.scope}
                        </span>
                        <span className="font-mono text-muted-foreground">{l.file}</span>
                        <code className="font-mono break-all">{l.target}</code>
                        {l.envKeys.length > 0 && <span className="text-muted-foreground">env / headers: {l.envKeys.join(", ")}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Hooks grouped by the tool that installed them (Orca, Superset, a plugin…), expanding to event, matcher, file and command. */
export function HooksView({ project }: { project?: string }) {
  const { data, error } = useList<HookGroup>(`/api/hooks?project=${encodeURIComponent(project ?? "")}`);
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(
    () =>
      (data ?? [])
        .map((g) => ({ ...g, hooks: g.hooks.filter((h) => agent === "all" || h.agent === agent) }))
        .filter((g) => g.hooks.length && `${g.owner} ${g.hooks.map((h) => `${h.event} ${h.command}`).join(" ")}`.toLowerCase().includes(query.toLowerCase())),
    [data, query, agent],
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Commands agents run on events (session start, before a tool, on stop…). Read from your Claude Code settings, the repo's settings, enabled plugins and ~/.cursor/hooks.json.
      </p>
      <Toolbar query={query} setQuery={setQuery} agent={agent} setAgent={setAgent} placeholder="Search by tool, event or command" />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!data && !error ? (
        <Spinner />
      ) : groups.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No hooks</EmptyTitle>
            <EmptyDescription>Nothing matches this filter.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="divide-y overflow-hidden rounded-lg border bg-card">
          {groups.map((g) => {
            const isOpen = open === g.owner;
            const agents = [...new Set(g.hooks.map((h) => h.agent))];
            const events = [...new Set(g.hooks.map((h) => h.event))];
            return (
              <div key={g.owner}>
                <button className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-muted/30" onClick={() => setOpen(isOpen ? null : g.owner)} aria-expanded={isOpen}>
                  <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{g.owner}</span>
                      <span className="text-xs text-muted-foreground tabular">{g.hooks.length} hooks</span>
                    </span>
                    <span className="line-clamp-1 text-xs text-muted-foreground">{events.join(", ")}</span>
                  </span>
                  <span className="flex flex-wrap justify-end gap-1">
                    {agents.map((a) => (
                      <Badge key={a} variant="secondary" className="font-normal">
                        {a}
                      </Badge>
                    ))}
                  </span>
                </button>
                {isOpen && (
                  <div className="flex flex-col divide-y bg-muted/20">
                    {g.hooks.map((h, i) => (
                      <div key={i} className="flex flex-col gap-0.5 px-11 py-2 text-xs">
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">{h.event}</Badge>
                          {h.matcher && <span className="text-muted-foreground">matcher: {h.matcher}</span>}
                          <span className="text-muted-foreground">
                            {h.agent} · {h.source}
                          </span>
                        </span>
                        <span className="font-mono text-muted-foreground">{h.file}</span>
                        <code className="line-clamp-3 font-mono break-all" title={h.command}>
                          {h.command}
                        </code>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
