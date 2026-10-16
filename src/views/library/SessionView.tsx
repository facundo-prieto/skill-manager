import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronRight, Search, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ago, fmtTokens, get, keyOf, sum, uses, type Skill, type Usage, type Verify } from "@/lib/api";

type Show = "all" | "on" | "off" | "unused";

const groupOf = (s: Skill) =>
  s.origin.kind === "github" ? `npx · ${s.origin.label}` : s.origin.kind === "plugin" ? `Plugin · ${s.origin.label}` : s.origin.kind === "satl" ? s.origin.label : s.scope === "project" ? "Yours · this repo" : "Yours";
const ORDER = (g: string) => (g.startsWith("Yours") ? 0 : g.startsWith("npx") ? 1 : g.startsWith("SATL") ? 2 : 3);

/**
 * Pick what the next launch loads. Nothing is installed or removed here — skills that are off are just hidden
 * through the launch command (skillOverrides for skills, enabledPlugins for whole plugins).
 */
export function SessionView({ skills, off, setOff, usage, project, onOpen }: { skills: Skill[]; off: Set<string>; setOff: (s: Set<string>) => void; usage: Record<string, Usage>; project?: string; onOpen: (s: Skill) => void }) {
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [verify, setVerify] = useState<Verify | "running" | null>(null);

  const isOn = (s: Skill) => !off.has(keyOf(s));
  const setMany = (keys: string[], on: boolean) => {
    const next = new Set(off);
    keys.forEach((k) => (on ? next.delete(k) : next.add(k)));
    setOff(next);
  };
  const on = skills.filter(isOn);

  const groups = useMemo(() => {
    const q = query.toLowerCase();
    const visible = skills
      .filter((s) => `${s.name} ${s.description} ${s.origin.label}`.toLowerCase().includes(q))
      .filter((s) => (show === "on" ? isOn(s) : show === "off" ? !isOn(s) : show === "unused" ? !uses(usage[s.name]) : true))
      .toSorted((a, b) => a.name.localeCompare(b.name));
    return [...Map.groupBy(visible, groupOf)].sort(([a], [b]) => ORDER(a) - ORDER(b) || a.localeCompare(b));
  }, [skills, off, usage, query, show]);

  const runVerify = async () => {
    setVerify("running");
    try {
      setVerify(await get<Verify>(`/api/verify?project=${encodeURIComponent(project ?? "")}`));
    } catch (e) {
      toast.error((e as Error).message);
      setVerify(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="w-full text-sm text-muted-foreground lg:w-auto lg:flex-1">
          <span className="font-medium text-foreground tabular">
            {on.length} of {skills.length}
          </span>{" "}
          skills on · ~{fmtTokens(sum(on, "listingTokens"))} tokens in every session. Off only hides them from the next launch; nothing is uninstalled.
        </p>
        <Button variant="outline" onClick={() => setOff(new Set())}>
          All on
        </Button>
        <Button variant="outline" onClick={() => setOff(new Set(skills.map(keyOf)))}>
          All off
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">More</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => setMany(skills.filter((s) => !s.plugin && !uses(usage[s.name])).map(keyOf), false)}>Turn off never-used skills</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setMany(skills.filter((s) => s.listingTokens === 0).map(keyOf), true)}>Turn on everything that costs nothing</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={runVerify}>
                <ShieldCheck /> Check against Claude Code
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {verify && <VerifyResult result={verify} onClose={() => setVerify(null)} />}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search name, description or source" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <ToggleGroup type="single" variant="outline" value={show} onValueChange={(v) => v && setShow(v as Show)}>
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="on">On</ToggleGroupItem>
          <ToggleGroupItem value="off">Off</ToggleGroupItem>
          <ToggleGroupItem value="unused">Never used</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {groups.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No skills match</EmptyTitle>
            <EmptyDescription>Try another filter.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map(([group, list]) => {
            const plugin = list[0]!.plugin; // plugins switch as a whole, like everywhere else
            const keys = [...new Set(list.map(keyOf))];
            const allOn = list.every(isOn);
            const open = !folded.has(group);
            return (
              <section key={group} className="overflow-hidden rounded-lg border bg-card">
                <div className="flex items-center gap-3 border-b bg-muted/30 px-4 py-2">
                  <Switch checked={allOn} onCheckedChange={(v) => setMany(keys, v)} aria-label={`Turn ${group} ${allOn ? "off" : "on"}`} />
                  <button className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium" onClick={() => setFolded((f) => (f.has(group) ? (f.delete(group), new Set(f)) : new Set(f.add(group))))}>
                    <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
                    <span className="truncate">{group}</span>
                    <span className="text-xs font-normal text-muted-foreground tabular">
                      {list.filter(isOn).length}/{list.length} on
                    </span>
                  </button>
                  <span className="text-xs text-muted-foreground tabular">~{fmtTokens(sum(list.filter(isOn), "listingTokens"))} tok</span>
                </div>
                {open && (
                  <div className="divide-y">
                    {list.map((s) => {
                      const u = usage[s.name];
                      const sOn = isOn(s);
                      return (
                        <div key={s.path} className={cn("flex items-start gap-3 px-4 py-2.5", !sOn && "text-muted-foreground")}>
                          {plugin ? (
                            <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", sOn ? "bg-primary" : "bg-muted-foreground/30")} title="Part of a plugin: use the group switch" />
                          ) : (
                            <Switch className="mt-0.5" checked={sOn} onCheckedChange={(v) => setMany([keyOf(s)], v)} aria-label={s.name} />
                          )}
                          <button className="min-w-0 flex-1 text-left" onClick={() => onOpen(s)}>
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-[13px] font-medium text-foreground hover:underline">{s.name}</span>
                              {s.modelOnly && <Badge variant="outline">model only</Badge>}
                              {s.paths && <Badge variant="outline">conditional</Badge>}
                            </span>
                            <span className="line-clamp-1 text-xs text-muted-foreground">{s.description || "No description"}</span>
                          </button>
                          <span className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground tabular sm:block" title={`${s.listingTokens} always · ${s.bodyTokens} when used`}>
                            {s.listingTokens ? `~${fmtTokens(s.listingTokens)}` : "hidden"}
                          </span>
                          <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground tabular sm:block">{u ? `${uses(u)} · ${ago(u.lastUsed)}` : "never used"}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function VerifyResult({ result, onClose }: { result: Verify | "running"; onClose: () => void }) {
  if (result === "running")
    return (
      <Alert>
        <Spinner />
        <AlertTitle>Checking against Claude Code</AlertTitle>
        <AlertDescription>Starting a throwaway session to read the skill list it loads…</AlertDescription>
      </Alert>
    );
  const { claudeOnly, managerOnly } = result;
  const ok = !claudeOnly.other.length && !managerOnly.length;
  return (
    <Alert variant={ok ? "default" : "destructive"}>
      <ShieldCheck />
      <AlertTitle className="flex items-center justify-between">
        {ok ? "This matches what Claude Code loads." : "This list and Claude Code disagree."}
        <Button size="sm" variant="ghost" onClick={onClose}>
          Dismiss
        </Button>
      </AlertTitle>
      <AlertDescription>
        {claudeOnly.other.length > 0 && <p>Claude has these, the manager doesn't: {claudeOnly.other.join(", ")}</p>}
        {managerOnly.length > 0 && <p>The manager shows these, Claude doesn't load them: {managerOnly.join(", ")}</p>}
        <p>
          Not managed here: {claudeOnly.builtIn.length} built-in commands, {claudeOnly.claudeAi.length} claude.ai skills, {claudeOnly.mcp.length} MCP prompts. Model-only and conditional skills are expected to be
          missing from Claude's startup list.
        </p>
      </AlertDescription>
    </Alert>
  );
}
