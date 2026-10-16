import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Link2, Loader2, Plus, Puzzle, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useJobs } from "@/lib/jobs";
import { RemoveDialog } from "@/components/SkillLocations";
import { ago, get, type AgentCopy, type AgentMatrix, type AgentRow } from "@/lib/api";

type Filter = "missing" | "single" | "differ" | "all";

const hashes = (r: AgentRow) => new Set(Object.values(r.copies).map((c) => c!.hash));
const newest = (r: AgentRow) => Math.max(...Object.values(r.copies).map((c) => c!.modified));

/** Which agent has which skill: spot skills only Codex got by accident, or ones Claude is missing. */
export function AgentsView() {
  const { run, revision } = useJobs();
  const [matrix, setMatrix] = useState<AgentMatrix | null>(null);
  const [filter, setFilter] = useState<Filter>("missing");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<string | null>(null);

  const load = async () => {
    try {
      setMatrix(await get<AgentMatrix>("/api/agents"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  useEffect(() => void load(), [revision]); // reload after queued jobs finish

  const rows = useMemo(() => {
    if (!matrix) return [];
    const q = query.toLowerCase();
    return matrix.rows
      .filter((r) => r.name.toLowerCase().includes(q) || (r.npxSource ?? "").toLowerCase().includes(q))
      .filter((r) =>
        filter === "missing" ? !r.copies.claude
        : filter === "single" ? Object.keys(r.copies).length === 1
        : filter === "differ" ? hashes(r).size > 1
        : true,
      );
  }, [matrix, filter, query]);

  if (!matrix)
    return (
      <p className="flex items-center justify-center gap-2 rounded-lg border px-4 py-10 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Reading every agent's skills folder…
      </p>
    );

  const addable = [...picked].filter((n) => !matrix.rows.find((r) => r.name === n)?.copies.claude);
  const toggle = (n: string) => setPicked((p) => (p.has(n) ? (p.delete(n), new Set(p)) : new Set(p.add(n))));
  const addToClaude = async (names: string[]) => {
    if (await run("/api/agents/add-to-claude", { names })) setPicked(new Set());
  };

  const cols = `1.75rem minmax(11rem,1fr) repeat(${matrix.agents.length}, 3.5rem) 4.5rem`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search skills or npx source" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList>
            <TabsTrigger value="missing">Missing in Claude</TabsTrigger>
            <TabsTrigger value="single">Only one agent</TabsTrigger>
            <TabsTrigger value="differ">Versions differ</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <div className="grid min-w-fit items-end gap-x-2 border-b bg-muted/50 px-3 py-2 text-xs text-muted-foreground" style={{ gridTemplateColumns: cols }}>
          <span />
          <span>Skill</span>
          {matrix.agents.map((a) => (
            <Tooltip key={a.id}>
              <TooltipTrigger className="text-center leading-tight">
                {a.label.split(" (")[0]!.replace(" CLI", "").replace("Claude Code", "Claude")}
                <span className="block tabular">{a.count}</span>
              </TooltipTrigger>
              <TooltipContent>
                {a.label} — {a.dir}
              </TooltipContent>
            </Tooltip>
          ))}
          <span />
        </div>
        {rows.length === 0 && <p className="px-4 py-10 text-center text-sm text-muted-foreground">Nothing here. Every agent is in sync for this filter.</p>}
        {rows.map((r) => {
          const latest = newest(r);
          const differ = hashes(r).size > 1;
          return (
            <div key={r.name} className="grid min-w-fit items-center gap-x-2 border-t px-3 py-1.5 first:border-t-0 hover:bg-muted/30" style={{ gridTemplateColumns: cols }}>
              <Checkbox checked={picked.has(r.name)} onCheckedChange={() => toggle(r.name)} disabled={!!r.copies.claude} aria-label={r.name} />
              <span className="min-w-0">
                <span className="block truncate font-mono text-[13px]" title={r.name}>{r.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {r.npxSource ? `npx · ${r.npxSource}` : "hand-made or copied"}
                  {differ && <span className="text-amber-700 dark:text-amber-400"> · versions differ</span>}
                </span>
              </span>
              {matrix.agents.map((a) => (
                <Cell key={a.id} copy={r.copies[a.id]} isNewest={!!r.copies[a.id] && r.copies[a.id]!.modified === latest} differ={differ} />
              ))}
              <span className="flex justify-end">
                {Object.values(r.copies).some((c) => !c!.viaPlugin) && (
                  <Button size="icon" variant="ghost" className="size-8" onClick={() => setRemoving(r.name)} aria-label={`Remove ${r.name}`} title="Remove from some or all agents…">
                    <Trash2 />
                  </Button>
                )}
                {!r.copies.claude && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    onClick={() => addToClaude([r.name])}
                    aria-label={`Add ${r.name} to Claude Code`}
                    title={r.npxSource ? `Add to Claude Code: reinstall from ${r.npxSource}` : "Add to Claude Code: copy the most recently edited version"}
                  >
                    <Plus />
                  </Button>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        ● has it · <span className="text-amber-600 dark:text-amber-400">●</span> older copy than another agent's · <Puzzle className="inline size-3" /> via a Claude plugin ·{" "}
        <Link2 className="inline size-3" /> symlink. Adding to Claude reinstalls npx skills from their repo, and copies everything else from the newest version.
      </p>

      <RemoveDialog name={removing} onClose={() => setRemoving(null)} />

      {addable.length > 0 && (
        <div className="sticky bottom-[4.75rem] z-10 flex items-center gap-3 rounded-lg border bg-card px-4 py-3 shadow-sm">
          <p className="flex-1 text-sm">{addable.length} selected</p>
          <Button variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>
          <Button onClick={() => addToClaude(addable)}>
            <Plus /> Add to Claude Code
          </Button>
        </div>
      )}
    </div>
  );
}

function Cell({ copy, isNewest, differ }: { copy?: AgentCopy; isNewest: boolean; differ: boolean }) {
  if (!copy) return <span className="text-center text-muted-foreground/40">–</span>;
  return (
    <Tooltip>
      <TooltipTrigger className="flex items-center justify-center gap-0.5">
        {copy.viaPlugin ? (
          <Puzzle className="size-3.5 text-primary" />
        ) : (
          <span className={cn("size-2.5 rounded-full", differ && !isNewest ? "bg-amber-500" : "bg-primary")} />
        )}
        {copy.link && <Link2 className="size-3 text-muted-foreground" />}
      </TooltipTrigger>
      <TooltipContent>
        {copy.viaPlugin ? `From plugin ${copy.viaPlugin}` : copy.path.replace(/^\/Users\/[^/]+/, "~")}
        {copy.link && ` → ${copy.link}`}
        <br />
        Edited {ago(copy.modified)}
        {differ && (isNewest ? " (newest)" : " (older than another copy)")}
      </TooltipContent>
    </Tooltip>
  );
}
