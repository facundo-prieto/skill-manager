import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Plug, Settings, Webhook, Archive as ArchiveIcon, ArrowLeft, ArrowUpCircle, Bot, ChevronRight, Copy, Download, ExternalLink, EyeOff, FolderGit2, GitPullRequestArrow, Layers, MoreHorizontal, Package, Pin, RefreshCw, Rocket, Search, Stethoscope, Trash2, User, Users, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { useJobs } from "@/lib/jobs";
import { ago, fmtTokens, get, post, uses, type Repo, type SearchHit, type Finding, type Namespace, type Plugin, type RepoSkill, type SatlStatus, type Skill, type SourceSummary, type UpdateStatus, type Usage } from "@/lib/api";
import { DoctorView } from "@/views/DoctorView";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SkillDrawer, type DrawerSkill } from "./SkillDrawer";
import { SessionView } from "./SessionView";
import { HooksView, McpView } from "./IntegrationsView";
import { SettingsView } from "@/views/SettingsView";

/* ── model ─────────────────────────────────────────────────────────────────────────────── */

type Ref =
  | { kind: "view"; id: "session" | "all" | "duplicates" | "attention" | "satl-browse" | "agents" | "archive" | "mcp" | "hooks" | "settings" }
  | { kind: "search"; q: string }
  | { kind: "local"; scope: "global" | "project" }
  | { kind: "npx"; repo: string }
  | { kind: "satl"; token: string }
  | { kind: "plugin"; id: string };
const refKey = (r: Ref) => JSON.stringify(r);

/** One staged change. Nothing touches disk until "Apply", which hands each change to the job queue. */
type Change =
  | { type: "npx-add"; source: string; name: string }
  | { type: "npx-remove"; name: string }
  | { type: "remove-path"; name: string; path: string }
  | { type: "plugin"; id: string; enable: boolean }
  | { type: "satl"; token: string; include: boolean };
const changeKey = (c: Change) =>
  c.type === "npx-add" ? `npx:${c.name}` : c.type === "npx-remove" ? `npx:${c.name}` : c.type === "remove-path" ? `path:${c.path}` : c.type === "plugin" ? `plugin:${c.id}` : `satl:${c.token}`;
const changeLabel = (c: Change) =>
  c.type === "npx-add" ? `+ ${c.name}` : c.type === "npx-remove" ? `− ${c.name}` : c.type === "remove-path" ? `Archive ${c.name}` : c.type === "plugin" ? `${c.enable ? "Enable" : "Disable"} ${c.id.split("@")[0]}` : `${c.include ? "+" : "−"} ${c.token.replace(/^.*\/skills\//, "")}`;
const verb = (c: Change | undefined, on: boolean) => (on ? "install" : c?.type === "remove-path" ? "archive" : "remove"); // your own skills go to the archive, never straight to the bin

/** A row in the list. `toggle` exists only when the skill can be picked on its own (the per-skill rule). */
type Item = {
  key: string;
  name: string;
  description: string;
  installed: boolean;
  change?: (installed: boolean) => Change; // flipping the checkbox stages this
  status?: "update" | "moved" | "gone" | "duplicate";
  fresh?: boolean; // became an update in the last check
  takenBy?: string; // another skill with this name is the one Claude loads; installing this would replace it
  drawer: DrawerSkill;
  usageKey?: string;
  context?: { listing: number; body: number };
};

const ORIGIN = (s: Skill) =>
  s.origin.kind === "github" ? `npx · ${s.origin.label}` : s.origin.kind === "plugin" ? `Plugin · ${s.origin.label}` : s.origin.kind === "satl" ? s.origin.label : s.origin.kind === "link" ? "Linked folder" : "Yours";
const baseName = (s: Skill) => (s.plugin ? s.name.split(":")[1]! : s.name);

function itemFromSkill(s: Skill, updates: Map<string, UpdateStatus>, dupNames: Set<string>): Item {
  const u = updates.get(s.name);
  const pickable = s.origin.kind === "github" || s.origin.kind === "local" || s.origin.kind === "link";
  return {
    key: s.path,
    name: s.name,
    description: s.description,
    installed: true,
    change: pickable ? () => (s.origin.kind === "github" ? { type: "npx-remove", name: s.name } : { type: "remove-path", name: s.name, path: s.path }) : undefined,
    status: u?.status === "update" || u?.status === "moved" ? u.status : u?.status === "removed" ? "gone" : dupNames.has(baseName(s)) ? "duplicate" : undefined,
    drawer: { name: s.name, description: s.description, origin: ORIGIN(s), path: s.path, installed: true, listingTokens: s.listingTokens, bodyTokens: s.bodyTokens, npxSource: s.origin.kind === "github" ? s.origin.label : undefined, archivable: s.origin.kind === "local" || s.origin.kind === "link" },
    usageKey: s.name,
    context: { listing: s.listingTokens, body: s.bodyTokens },
  };
}

/* ── view ──────────────────────────────────────────────────────────────────────────────── */

type Props = {
  skills: Skill[];
  usage: Record<string, Usage>;
  updates: UpdateStatus[] | null;
  findings: Finding[] | null;
  refreshDoctor: () => Promise<void>;
  turnOff: (keys: string[]) => void;
  project?: string;
  onPickProject: (path: string) => void;
  onChanged: () => void;
  /** Screens that live elsewhere but belong in the sidebar */
  extra: { agents: ReactNode; archive: ReactNode };
  off: Set<string>;
  setOff: (s: Set<string>) => void;
  archivedCount: number;
  sessionOff: number;
  topBar: ReactNode; // launch summary + activity, right side of the page header
  checkUpdates: (source?: string) => Promise<UpdateStatus[]>;
  repoPicker: ReactNode; // top of the sidebar
};

export function LibraryView({ skills, usage, updates, findings, refreshDoctor, turnOff, project, onPickProject, onChanged, extra, archivedCount, sessionOff, topBar, repoPicker, checkUpdates, off, setOff }: Props) {
  const { run, revision, jobs } = useJobs();
  const [selected, setSelected] = useState<Ref>({ kind: "view", id: "all" });
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [catalog, setCatalog] = useState<Namespace[]>([]);
  const [configRev, setConfigRev] = useState(0); // Settings saved: SATL path or repo list may have changed
  const [satl, setSatl] = useState<SatlStatus | null>(null);
  const [repoCache, setRepoCache] = useState<Record<string, RepoSkill[] | "loading" | string>>({});
  const repoCacheRef = useRef(repoCache);
  repoCacheRef.current = repoCache;
  const [changes, setChanges] = useState<Map<string, Change>>(new Map());
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<"all" | "installed" | "available">("all");
  const [drawer, setDrawer] = useState<{ skill: DrawerSkill; usageKey?: string } | null>(null);
  const [satlRepos, setSatlRepos] = useState<Repo[]>([]);
  useEffect(() => void get<Repo[]>("/api/repos").then((r) => setSatlRepos(r.filter((x) => x.satl))), []);

  // sidebar clicks start fresh; drilling in from a page (search → repo) can go Back
  const [history, setHistory] = useState<Ref[]>([]);
  const go = (r: Ref, drill = false) => {
    setHistory((h) => (drill ? [...h, selected] : []));
    if (!drill) setDrawer(null); // a new section starts without the previous quick view
    setSelected(r);
  };
  const back = () => {
    const prev = history.at(-1);
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setSelected(prev);
  };

  // "check for updates": what turned into an update since the previous check gets highlighted
  const [freshlyChanged, setFreshlyChanged] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState<string | null>(null); // "all" | repo | "satl"
  const [checkedAt, setCheckedAt] = useState<Record<string, number>>({});
  const runCheck = async (source?: string) => {
    const key = source ?? "all";
    setChecking(key);
    const before = new Map((updates ?? []).map((u) => [u.name, u.status]));
    const list = await checkUpdates(source);
    const pending = list.filter((u) => u.inClaude && (u.status === "update" || u.status === "moved"));
    const fresh = pending.filter((u) => before.get(u.name) !== u.status).map((u) => u.name);
    setFreshlyChanged((s) => new Set([...s, ...fresh]));
    setCheckedAt((c) => ({ ...c, [key]: Date.now() }));
    setChecking(null);
    toast[pending.length ? "info" : "success"](
      pending.length ? `${pending.length} update${pending.length > 1 ? "s" : ""} available${fresh.length ? ` (${fresh.length} new)` : ""}` : `${source ?? "All sources"}: everything up to date`,
      { description: pending.slice(0, 6).map((u) => u.name).join(", ") || undefined },
    );
  };
  const checkSatl = async () => {
    if (!project) return;
    setChecking("satl");
    try {
      const s = await get<SatlStatus>(`/api/satl/status?project=${encodeURIComponent(project)}&fetch`);
      setSatl(s);
      toast[s.changed.length ? "info" : "success"](s.changed.length ? `Changed in SATL: ${s.changed.join(", ")}` : "Your SATL teams are up to date", {
        description: s.clone.behind ? `Knowledge base is ${s.clone.behind} commits behind: Pull and sync from Browse.` : undefined,
      });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setChecking(null);
    }
  };

  // changes handed to the queue; shown as already done (with a spinner) until the queue is idle and data reloads
  const [inFlight, setInFlight] = useState<Map<string, Change>>(new Map());
  const queueBusy = jobs.some((j) => j.status === "queued" || j.status === "running");

  // everything that can change after a queued job finishes is reloaded on `revision`
  useEffect(() => {
    const idle = !queueBusy;
    void Promise.all([
      get<SourceSummary[]>("/api/sources").then(setSources),
      get<Plugin[]>(`/api/plugins?project=${encodeURIComponent(project ?? "")}`).then(setPlugins),
      get<Namespace[]>("/api/satl/catalog").then(setCatalog),
      project ? get<SatlStatus>(`/api/satl/status?project=${encodeURIComponent(project)}`).then(setSatl, () => setSatl(null)) : (setSatl(null), undefined),
      // revalidate repos already on screen in the background — no spinner, the optimistic state stays until real data lands
      ...Object.entries(repoCacheRef.current)
        .filter(([, v]) => Array.isArray(v))
        .map(([repo]) => get<RepoSkill[]>(`/api/source?repo=${encodeURIComponent(repo)}`).then((list) => setRepoCache((c) => ({ ...c, [repo]: list })), () => {})),
    ]).finally(() => idle && setInFlight(new Map())); // fresh data is in: drop the optimistic markers
  }, [revision, project, configRev]);
  useEffect(() => {
    if (selected.kind !== "npx" || repoCache[selected.repo]) return;
    const repo = selected.repo;
    setRepoCache((c) => ({ ...c, [repo]: "loading" }));
    get<RepoSkill[]>(`/api/source?repo=${encodeURIComponent(repo)}`).then(
      (list) => setRepoCache((c) => ({ ...c, [repo]: list })),
      (e) => setRepoCache((c) => ({ ...c, [repo]: e.message })),
    );
  }, [selected, repoCache]);
  useEffect(() => (setQuery(""), setShow("all")), [refKey(selected)]);

  const updateMap = useMemo(() => new Map((updates ?? []).filter((u) => u.inClaude).map((u) => [u.name, u])), [updates]);
  const dupGroups = useMemo(() => [...Map.groupBy(skills, baseName)].filter(([, l]) => l.length > 1), [skills]);
  const dupNames = useMemo(() => new Set(dupGroups.map(([n]) => n)), [dupGroups]);
  const issues = findings?.filter((f) => f.severity !== "info").length ?? 0;
  const satlInstalled = (token: string) => {
    const flight = inFlight.get(`satl:${token}`);
    return flight?.type === "satl" ? flight.include : !!satl?.includes.includes(token);
  };
  // one skill picked or dropped inside a namespace: team/<ns>/skills/<id>
  const satlSkillOn = (ns: string, id: string) => {
    const t = `${ns}/skills/${id}`; // its own in-flight change is applied by `effective`, like npx rows
    return !satl?.excludes.includes(t) && (satlInstalled(ns) || !!satl?.includes.includes(t));
  };
  const isTeam = (t: string) => t.split("/").length === 2;
  const satlTeams = [...new Set([...(satl?.includes ?? []).filter(isTeam), ...[...inFlight.values()].flatMap((c) => (c.type === "satl" && c.include && isTeam(c.token) ? [c.token] : []))])]
    .filter(satlInstalled)
    .map((token) => ({ token, applying: inFlight.has(`satl:${token}`) }));

  const stage = (c: Change, undo: boolean) =>
    setChanges((m) => {
      const n = new Map(m);
      undo ? n.delete(changeKey(c)) : n.set(changeKey(c), c);
      return n;
    });

  /* items for the selected source */
  const { items, bundle, header } = useMemo((): { items: Item[] | null; bundle?: BundleProps; header: HeaderProps } => {
    const fromScan = (list: Skill[]) => list.toSorted((a, b) => a.name.localeCompare(b.name)).map((s) => itemFromSkill(s, updateMap, dupNames));
    switch (selected.kind) {
      case "view":
        if (selected.id === "all") return { items: fromScan(skills), header: { title: "All skills", subtitle: `${skills.length} skills Claude Code loads right now` } };
        return { items: null, header: { title: selected.id } };
      case "search":
        return { items: null, header: { title: `“${selected.q}” on skills.sh` } };
      case "local": {
        const list = skills.filter((s) => (s.origin.kind === "local" || s.origin.kind === "link") && s.scope === selected.scope);
        return {
          items: fromScan(list),
          header: {
            title: selected.scope === "global" ? "Your skills" : "This repo's skills",
            subtitle: `${list.length} skills you made or copied by hand, in ${selected.scope === "global" ? "~/.claude/skills" : ".claude/skills"}`,
          },
        };
      }
      case "npx": {
        const cached = repoCache[selected.repo];
        const src = sources.find((s) => s.source === selected.repo);
        const header: HeaderProps = {
          title: selected.repo,
          subtitle: src ? `using ${src.inClaude} of ${src.available ?? "?"} skills · installed with npx skills` : "Not one of your sources yet",
          href: `https://github.com/${selected.repo}`,
          source: { repo: selected.repo, listed: !!src, installed: src?.inClaude ?? 0 },
        };
        if (!Array.isArray(cached)) return { items: null, header: { ...header, loading: cached === "loading" || !cached, error: typeof cached === "string" && cached !== "loading" ? cached : undefined } };
        const byName = new Map(skills.filter((s) => s.origin.kind === "github" && s.origin.label === selected.repo).map((s) => [s.name, s]));
        const items: Item[] = cached.map((r) => {
          const installed = r.installed === "claude";
          const local = r.takenBy ? undefined : byName.get(r.name);
          const u = updateMap.get(r.name);
          return {
            key: `${selected.repo}/${r.path}`,
            name: r.name,
            description: r.description,
            installed,
            change: r.takenBy ? undefined : (wasInstalled) => (wasInstalled ? { type: "npx-remove", name: r.name } : { type: "npx-add", source: selected.repo, name: r.name }),
            takenBy: r.takenBy,
            status: u?.status === "update" || u?.status === "moved" ? u.status : installed && dupNames.has(r.name) ? "duplicate" : undefined,
            drawer: local
              ? { name: r.name, description: r.description, origin: `npx · ${selected.repo}`, path: local.path, installed: true, listingTokens: local.listingTokens, bodyTokens: local.bodyTokens, npxSource: selected.repo }
              : { name: r.name, description: r.description, origin: `npx · ${selected.repo}`, remote: { repo: selected.repo, folder: r.path }, installed: false },
            usageKey: r.name,
            context: local && { listing: local.listingTokens, body: local.bodyTokens },
          };
        });
        // skills the lock still tracks but the repo dropped
        for (const u of updates ?? []) {
          const local = byName.get(u.name);
          if (u.source === selected.repo && u.status === "removed" && u.inClaude && local) items.push({ ...itemFromSkill(local, updateMap, dupNames), status: "gone" });
        }
        for (const i of items) i.fresh = freshlyChanged.has(i.name) && (i.status === "update" || i.status === "moved");
        const pending = items.filter((i) => i.status === "update" || i.status === "moved").map((i) => i.name);
        return { items, header: { ...header, updates: pending, check: selected.repo } };
      }
      case "satl": {
        const ns = catalog.find((n) => n.token === selected.token);
        const installed = satlInstalled(selected.token);
        const canPick = !!project && !!satl?.initialized;
        const items: Item[] = (ns?.skills ?? []).map((s) => ({
          key: s.path,
          name: s.name,
          description: s.description,
          installed: satlSkillOn(selected.token, s.id),
          change: canPick ? (on) => ({ type: "satl", token: `${selected.token}/skills/${s.id}`, include: !on }) : undefined,
          drawer: { name: s.name, description: s.description, origin: `SATL · ${selected.token}`, path: s.path, installed: false },
        }));
        const counts = Object.entries(ns?.counts ?? {})
          .filter(([, c]) => c)
          .map(([k, c]) => `${c} ${k}`)
          .join(", ");
        return {
          items,
          bundle: { label: "Installed in this repo", on: installed, disabled: !project || !satl?.initialized, hint: !project ? "Pick a repo at the top first: SATL installs per repo." : !satl?.initialized ? "This repo has no satl.json yet (run satl init there)." : undefined, change: { type: "satl", token: selected.token, include: !installed } },
          header: { title: selected.token, subtitle: `SATL namespace · ${counts || "empty"} · untick a skill to leave it out` },
        };
      }
      case "plugin": {
        const p = plugins.find((x) => x.id === selected.id);
        const flight = inFlight.get(`plugin:${selected.id}`);
        const on = flight?.type === "plugin" ? flight.enable : !!p && (p.enabled || p.projectEnabled);
        const scanned = new Map(skills.filter((s) => s.plugin === selected.id).map((s) => [s.name, s]));
        const items: Item[] = (p?.skills ?? []).map((s) => {
          const live = scanned.get(s.name);
          return {
            key: s.path,
            name: s.name,
            description: s.description,
            installed: on,
            status: dupNames.has(s.name.split(":")[1]!) && on ? "duplicate" : undefined,
            drawer: { name: s.name, description: s.description, origin: `Plugin · ${selected.id}`, path: s.path, installed: on, listingTokens: live?.listingTokens, bodyTokens: live?.bodyTokens },
            usageKey: s.name,
            context: live && { listing: live.listingTokens, body: live.bodyTokens },
          };
        });
        return {
          items,
          bundle: { label: "Enabled", on, disabled: !p || p.id.endsWith("@skills-dir"), change: { type: "plugin", id: selected.id, enable: !on } },
          header: {
            title: selected.id.split("@")[0]!,
            subtitle: `Plugin from ${selected.id.split("@")[1]} · ${p?.skills.length ?? 0} skills · turns on and off as a whole`,
            href: p?.repo && `https://github.com/${p.repo}`,
            plugin: p && !p.id.endsWith("@skills-dir") ? p.id : undefined,
            inventory: p?.components,
          },
        };
      }
    }
  }, [selected, skills, sources, plugins, catalog, satl, repoCache, updateMap, dupNames, updates, project, inFlight, freshlyChanged]);

  const effective = (i: Item) => {
    if (!i.change) return i.installed;
    const k = changeKey(i.change(i.installed));
    return changes.has(k) || inFlight.has(k) ? !i.installed : i.installed;
  };
  const visible = (items ?? [])
    .filter((i) => `${i.name} ${i.description}`.toLowerCase().includes(query.toLowerCase()))
    .filter((i) => (show === "installed" ? effective(i) : show === "available" ? !effective(i) : true));

  const apply = () => {
    const list = [...changes.values()];
    const adds = Map.groupBy(list.filter((c) => c.type === "npx-add"), (c) => c.source);
    for (const [source, cs] of adds) void run("/api/install", { source, skills: cs.map((c) => c.name) });
    const removes = list.filter((c) => c.type === "npx-remove").map((c) => c.name);
    if (removes.length) void run("/api/uninstall", { names: removes });
    for (const c of list) if (c.type === "remove-path") void run("/api/remove-everywhere", { name: c.name, paths: [c.path], project });
    for (const c of list) if (c.type === "plugin") void run("/api/plugins/action", { id: c.id, action: c.enable ? "enable" : "disable" });
    const satlChanges = list.filter((c) => c.type === "satl");
    if (satlChanges.length)
      void run("/api/satl/apply", { project, include: satlChanges.filter((c) => c.include).map((c) => c.token), exclude: satlChanges.filter((c) => !c.include).map((c) => c.token) });
    // optimistic: show the target state right away, with an "applying" marker until the queue catches up
    setInFlight((m) => new Map([...m, ...changes]));
    setChanges(new Map());
  };

  const open = (i: Item) => setDrawer({ skill: i.drawer, usageKey: i.usageKey });
  const title = selected.kind === "view" ? VIEW_TITLE[selected.id] : header.title;

  return (
    <SidebarProvider>
      <AppSidebar
        repoPicker={repoPicker}
        selected={selected}
        onSelect={(r) => go(r)}
        counts={{ all: skills.length, duplicates: dupGroups.length, attention: issues, archived: archivedCount, sessionOff }}
        local={skills.filter((s) => (s.origin.kind === "local" || s.origin.kind === "link") && s.scope === "global").length}
        projectLocal={project ? skills.filter((s) => s.origin.kind === "local" && s.scope === "project").length : null}
        sources={sources}
        updates={updates}
        satlInstalled={satlTeams}
        satlChanged={satl?.changed ?? []}
        checking={checking}
        onCheckNpx={() => runCheck()}
        onCheckSatl={checkSatl}
        applying={inFlight}
        project={project}
        satlRepos={satlRepos}
        satlMissing={catalog.length === 0}
        onPickProject={onPickProject}
        plugins={plugins}
        changes={changes}
      />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
          {history.length > 0 && (
            <Button variant="ghost" size="sm" onClick={back}>
              <ArrowLeft data-icon="inline-start" /> Back
            </Button>
          )}
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
          {topBar}
        </header>

        <div className="flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-5">
          {selected.kind === "view" && selected.id === "session" ? (
            <SessionView skills={skills} off={off} setOff={setOff} usage={usage} project={project} onOpen={(s) => setDrawer({ skill: itemFromSkill(s, updateMap, dupNames).drawer, usageKey: s.name })} />
          ) : selected.kind === "view" && selected.id === "mcp" ? (
            <McpView project={project} />
          ) : selected.kind === "view" && selected.id === "hooks" ? (
            <HooksView project={project} />
          ) : selected.kind === "view" && selected.id === "settings" ? (
            <SettingsView onSaved={() => (setConfigRev((r) => r + 1), onChanged())} />
          ) : selected.kind === "view" && (selected.id === "agents" || selected.id === "archive") ? (
            extra[selected.id]
          ) : selected.kind === "search" ? (
            <SearchResults q={selected.q} onOpen={(repo) => go({ kind: "npx", repo }, true)} />
          ) : selected.kind === "view" && selected.id === "attention" ? (
            <DoctorView findings={findings} refresh={refreshDoctor} onChanged={onChanged} turnOff={turnOff} />
          ) : selected.kind === "view" && selected.id === "duplicates" ? (
            <Duplicates groups={dupGroups} changes={changes} stage={stage} onOpen={(s) => setDrawer({ skill: itemFromSkill(s, updateMap, dupNames).drawer, usageKey: s.name })} />
          ) : selected.kind === "view" && selected.id === "satl-browse" ? (
            <SatlBrowse
              catalog={catalog}
              isInstalled={satlInstalled}
              skillOn={satlSkillOn}
              effective={effective}
              changes={changes}
              applying={inFlight}
              stage={stage}
              project={project}
              initialized={!!satl?.initialized}
              status={satl}
              usage={usage}
              onOpenSkill={(s, token) => setDrawer({ skill: { name: s.name, description: s.description, origin: `SATL · ${token}`, path: s.path, installed: satlInstalled(token) } })}
            />
          ) : (
            <>
              <Header
                {...header}
                onCheck={header.check ? () => runCheck(header.check) : undefined}
                checking={!!header.check && checking === header.check}
                checkedAt={header.check ? checkedAt[header.check] : undefined}
                onLeave={() => go({ kind: "view", id: "all" })}
                onRefresh={() => void get<SourceSummary[]>("/api/sources").then(setSources)}
                onUpdateAll={header.updates?.length ? () => run("/api/update-many", { items: header.updates!.map((name) => ({ name, movedTo: updateMap.get(name)?.movedTo })) }) : undefined}
              >
                {bundle && <BundleSwitch {...bundle} staged={changes.has(changeKey(bundle.change))} applying={inFlight.has(changeKey(bundle.change))} onToggle={(undo) => stage(bundle.change, undo)} />}
              </Header>
              {header.inventory && <Inventory c={header.inventory} />}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-56 flex-1">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input className="pl-8" placeholder="Search name or description" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                {selected.kind === "npx" && (
                  <ToggleGroup type="single" variant="outline" value={show} onValueChange={(v) => v && setShow(v as typeof show)}>
                    <ToggleGroupItem value="all">All</ToggleGroupItem>
                    <ToggleGroupItem value="installed">Installed</ToggleGroupItem>
                    <ToggleGroupItem value="available">Available</ToggleGroupItem>
                  </ToggleGroup>
                )}
              </div>
              {header.loading ? (
                <div className="flex items-center gap-2 rounded-lg border px-4 py-10 text-sm text-muted-foreground">
                  <Spinner /> Reading {header.title} from GitHub…
                </div>
              ) : header.error ? (
                <Empty className="border">
                  <EmptyHeader>
                    <EmptyTitle>Couldn't read {header.title}</EmptyTitle>
                    <EmptyDescription>{header.error}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : visible.length === 0 ? (
                <Empty className="border">
                  <EmptyHeader>
                    <EmptyTitle>No skills here</EmptyTitle>
                    <EmptyDescription>{query ? `Nothing matches “${query}”.` : header.inventory ? "This plugin has no skills; see what it does load above." : "This source doesn't publish any skills right now."}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <SkillList items={visible} effective={effective} changes={changes} applying={inFlight} stage={stage} usage={usage} onOpen={open} bundled={!!bundle} showOrigin={selected.kind === "view"} />
              )}
            </>
          )}
        </div>

        <SkillDrawer
          skill={drawer?.skill ?? null}
          usage={drawer?.usageKey ? usage[drawer.usageKey] : undefined}
          project={project}
          onClose={() => setDrawer(null)}
          onSaved={onChanged}
          update={drawer ? (updates ?? []).find((u) => u.name === drawer.skill.name) : undefined}
          onCheck={(source) => runCheck(source)}
          onArchive={(s) => {
            const c: Change = { type: "remove-path", name: s.name, path: s.path! };
            void run("/api/remove-everywhere", { name: c.name, paths: [c.path], project });
            setInFlight((m) => new Map(m).set(changeKey(c), c));
            setDrawer(null);
          }}
        />
        </div>

        {changes.size > 0 && (
          <div className="sticky bottom-0 z-10 flex items-center gap-3 border-t bg-card px-5 py-3">
            <p className="text-sm font-medium tabular">{changes.size} pending</p>
            <div className="flex min-w-0 flex-1 flex-wrap gap-1">
              {[...changes.entries()].map(([k, c]) => (
                <Badge key={k} variant="secondary" className="gap-1 font-normal">
                  {changeLabel(c)}
                  <button onClick={() => stage(c, true)} aria-label={`Undo ${changeLabel(c)}`}>
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
            <Button variant="ghost" onClick={() => setChanges(new Map())}>
              Discard
            </Button>
            <Button onClick={apply}>Apply changes</Button>
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}

const VIEW_TITLE: Record<Extract<Ref, { kind: "view" }>["id"], string> = {
  session: "Next session",
  all: "All skills",
  duplicates: "Duplicates",
  attention: "Needs a look",
  "satl-browse": "SATL teams & people",
  agents: "Agents",
  archive: "Archive",
  mcp: "MCP servers",
  hooks: "Hooks",
  settings: "Settings",
};

/* ── sidebar (shadcn Sidebar) ──────────────────────────────────────────────────────────── */

type SidebarProps = {
  repoPicker: ReactNode;
  selected: Ref;
  onSelect: (r: Ref) => void;
  counts: { all: number; duplicates: number; attention: number; archived: number; sessionOff: number };
  local: number;
  projectLocal: number | null;
  sources: SourceSummary[];
  updates: UpdateStatus[] | null;
  satlInstalled: { token: string; applying: boolean }[];
  satlChanged: string[];
  checking: string | null;
  onCheckNpx: () => void;
  onCheckSatl: () => void;
  applying: Map<string, Change>;
  project?: string;
  satlRepos: Repo[];
  satlMissing: boolean;
  onPickProject: (path: string) => void;
  plugins: Plugin[];
  changes: Map<string, Change>;
};

function AppSidebar(p: SidebarProps) {
  const [npxQuery, setNpxQuery] = useState("");
  const is = (r: Ref) => refKey(r) === refKey(p.selected);
  const pendingUpdates = (repo: string) => (p.updates ?? []).filter((u) => u.source === repo && u.inClaude && (u.status === "update" || u.status === "moved")).length;
  const pluginOn = (pl: Plugin) => {
    const flight = p.applying.get(`plugin:${pl.id}`);
    return flight?.type === "plugin" ? flight.enable : pl.enabled || pl.projectEnabled;
  };
  const sortedPlugins = [...p.plugins].filter((pl) => !pl.id.endsWith("@skills-dir")).sort((a, b) => Number(pluginOn(b)) - Number(pluginOn(a)) || a.id.localeCompare(b.id));
  const shownSources = p.sources.filter((s) => s.source.toLowerCase().includes(npxQuery.toLowerCase()));
  const submitNpx = () => {
    const q = npxQuery.trim();
    if (q) p.onSelect(/^[\w.-]+\/[\w.-]+$/.test(q) ? { kind: "npx", repo: q } : { kind: "search", q });
  };

  return (
    <Sidebar>
      <SidebarHeader className="gap-2">
        <span className="px-2 pt-1 text-sm font-semibold">Skill manager</span>
        {p.repoPicker}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <Item icon={Rocket} label="Next session" count={p.counts.sessionOff ? `${p.counts.sessionOff} off` : undefined} active={is({ kind: "view", id: "session" })} onClick={() => p.onSelect({ kind: "view", id: "session" })} />
              <Item icon={Layers} label="All skills" count={p.counts.all} active={is({ kind: "view", id: "all" })} onClick={() => p.onSelect({ kind: "view", id: "all" })} />
              <Item icon={Copy} label="Duplicates" count={p.counts.duplicates || undefined} badge active={is({ kind: "view", id: "duplicates" })} onClick={() => p.onSelect({ kind: "view", id: "duplicates" })} />
              <Item icon={Stethoscope} label="Needs a look" count={p.counts.attention || undefined} badge active={is({ kind: "view", id: "attention" })} onClick={() => p.onSelect({ kind: "view", id: "attention" })} />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <Section id="yours" label="Yours" count={p.local + (p.projectLocal ?? 0)}>
          <Item icon={User} label="Local skills" count={p.local} active={is({ kind: "local", scope: "global" })} onClick={() => p.onSelect({ kind: "local", scope: "global" })} />
          {p.projectLocal !== null && <Item icon={FolderGit2} label="This repo" count={p.projectLocal} active={is({ kind: "local", scope: "project" })} onClick={() => p.onSelect({ kind: "local", scope: "project" })} />}
        </Section>

        <Section id="npx" label="npx skills" count={p.sources.length} action={{ label: "Check all sources for updates", busy: p.checking === "all", onClick: p.onCheckNpx }}>
          <form onSubmit={(e) => (e.preventDefault(), submitNpx())} className="px-2 pb-1">
            <SidebarInput placeholder="Filter, search, owner/repo ↵" value={npxQuery} onChange={(e) => setNpxQuery(e.target.value)} />
          </form>
          {shownSources.map((s) => {
            const n = pendingUpdates(s.source);
            return (
              <Item
                key={s.source}
                label={s.source}
                count={n || (s.available ? `${s.inClaude}/${s.available}` : s.inClaude)}
                badge={n > 0}
                title={n ? `${n} updates` : s.available ? `using ${s.inClaude} of ${s.available}` : undefined}
                active={is({ kind: "npx", repo: s.source })}
                onClick={() => p.onSelect({ kind: "npx", repo: s.source })}
              />
            );
          })}
          {npxQuery && !shownSources.length && <p className="px-3 py-1 text-xs text-muted-foreground">Press Enter to search skills.sh</p>}
        </Section>

        <Section id="satl" label="SATL" count={p.satlInstalled.length || undefined} action={p.project ? { label: "Check your teams for changes", busy: p.checking === "satl", onClick: p.onCheckSatl } : undefined}>
          {p.satlMissing ? (
            <Item icon={Settings} label="Knowledge base not found: set it up" active={false} onClick={() => p.onSelect({ kind: "view", id: "settings" })} />
          ) : !p.project ? (
            <>
              <p className="px-3 pb-1 text-xs text-muted-foreground">SATL installs per repo. Pick one:</p>
              {p.satlRepos.map((r) => (
                <Item key={r.path} icon={FolderGit2} label={r.name} active={false} onClick={() => p.onPickProject(r.path)} />
              ))}
            </>
          ) : (
            <>
              <Item icon={Search} label="Browse teams & people" active={is({ kind: "view", id: "satl-browse" })} onClick={() => p.onSelect({ kind: "view", id: "satl-browse" })} />
              {p.satlInstalled.map(({ token, applying }) => (
                <Item
                  key={token}
                  icon={Users}
                  label={token}
                  applying={applying}
                  staged={p.changes.has(`satl:${token}`)}
                  count={p.satlChanged.includes(token) ? "changed" : undefined}
                  badge={p.satlChanged.includes(token)}
                  title={p.satlChanged.includes(token) ? "This team changed in the knowledge base since your last install" : undefined}
                  active={is({ kind: "satl", token })}
                  onClick={() => p.onSelect({ kind: "satl", token })}
                />
              ))}
            </>
          )}
        </Section>

        <Section id="plugins" label="Plugins" count={sortedPlugins.filter(pluginOn).length}>
          {sortedPlugins.map((pl) => {
            const empty = Object.values(pl.components).every((v) => !v);
            return (
              <Item
                key={`${pl.id}@${pl.version}`}
                icon={Package}
                label={pl.id.split("@")[0]!}
                dot={pluginOn(pl) ? "on" : "off"}
                applying={p.applying.has(`plugin:${pl.id}`)}
                staged={p.changes.has(`plugin:${pl.id}`)}
                count={empty ? "empty" : undefined}
                title={empty ? "Loads nothing: no skills, agents, hooks, MCP or LSP" : undefined}
                active={is({ kind: "plugin", id: pl.id })}
                onClick={() => p.onSelect({ kind: "plugin", id: pl.id })}
              />
            );
          })}
        </Section>

        <Section id="integrations" label="Integrations">
          <Item icon={Plug} label="MCP servers" active={is({ kind: "view", id: "mcp" })} onClick={() => p.onSelect({ kind: "view", id: "mcp" })} />
          <Item icon={Webhook} label="Hooks" active={is({ kind: "view", id: "hooks" })} onClick={() => p.onSelect({ kind: "view", id: "hooks" })} />
        </Section>

        <Section id="manage" label="Manage">
          <Item icon={Bot} label="Agents" active={is({ kind: "view", id: "agents" })} onClick={() => p.onSelect({ kind: "view", id: "agents" })} />
          <Item icon={ArchiveIcon} label="Archive" count={p.counts.archived || undefined} active={is({ kind: "view", id: "archive" })} onClick={() => p.onSelect({ kind: "view", id: "archive" })} />
          <Item icon={Settings} label="Settings" active={is({ kind: "view", id: "settings" })} onClick={() => p.onSelect({ kind: "view", id: "settings" })} />
        </Section>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}

// which sections are folded, remembered across reloads
const foldedStore = () => new Set<string>(JSON.parse(localStorage.getItem("library:folded") ?? "[]"));

function Section({ id, label, count, action, children }: { id: string; label: string; count?: number; action?: { label: string; busy: boolean; onClick: () => void }; children: ReactNode }) {
  const [open, setOpen] = useState(() => !foldedStore().has(id));
  const toggle = (o: boolean) => {
    setOpen(o);
    const f = foldedStore();
    o ? f.delete(id) : f.add(id);
    localStorage.setItem("library:folded", JSON.stringify([...f]));
  };
  return (
    <Collapsible open={open} onOpenChange={toggle} className="group/collapsible">
      <SidebarGroup className="py-1">
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger className="w-full">
            <ChevronRight className="transition-transform group-data-[state=open]/collapsible:rotate-90" />
            <span className="flex-1 text-left">{label}</span>
            {!open && count !== undefined && <span className="tabular">{count}</span>}
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        {action && (
          <SidebarGroupAction title={action.label} aria-label={action.label} onClick={action.onClick} disabled={action.busy}>
            {action.busy ? <Spinner /> : <RefreshCw />}
          </SidebarGroupAction>
        )}
        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>{children}</SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

function Item(p: {
  icon?: React.ComponentType;
  label: string;
  count?: number | string;
  badge?: boolean;
  title?: string;
  dot?: "on" | "off";
  staged?: boolean;
  applying?: boolean;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = p.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={p.active} onClick={p.onClick} tooltip={p.title} className={cn(p.dot === "off" && "text-muted-foreground")}>
        {Icon && <Icon />}
        {p.dot && <span className={cn("size-2 shrink-0 rounded-full", p.dot === "on" ? "bg-primary" : "bg-muted-foreground/30")} />}
        <span className="truncate">{p.label}</span>
      </SidebarMenuButton>
      {p.applying ? (
        <SidebarMenuBadge>
          <Spinner />
        </SidebarMenuBadge>
      ) : p.staged ? (
        <SidebarMenuBadge>pending</SidebarMenuBadge>
      ) : (
        p.count !== undefined && <SidebarMenuBadge className={cn(p.badge && "rounded-full bg-primary text-primary-foreground")}>{p.count}</SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}

/* ── main pane pieces ──────────────────────────────────────────────────────────────────── */

type HeaderProps = {
  title: string;
  subtitle?: string;
  href?: string;
  updates?: string[];
  loading?: boolean;
  error?: string;
  source?: { repo: string; listed: boolean; installed: number }; // npx source actions
  plugin?: string; // plugin actions
  inventory?: Plugin["components"];
  check?: string; // repo: show "Check for updates"
};

function Header({
  title,
  subtitle,
  href,
  updates,
  onUpdateAll,
  children,
  source,
  plugin,
  onLeave,
  onRefresh,
  check,
  onCheck,
  checking,
  checkedAt,
}: HeaderProps & { onUpdateAll?: () => void; children?: ReactNode; onLeave?: () => void; onRefresh?: () => void; onCheck?: () => void; checking?: boolean; checkedAt?: number }) {
  const { run } = useJobs();
  const pin = () => post("/api/sources/pin", { repo: source!.repo }).then(() => (toast.success(`${source!.repo} added to your sources`), onRefresh?.()), (e) => toast.error(e.message));
  const hide = () => post("/api/sources/hide", { repo: source!.repo }).then(() => (toast.success(`${source!.repo} hidden`), onLeave?.(), onRefresh?.()), (e) => toast.error(e.message));
  return (
    <header className="flex flex-wrap items-start gap-3">
      {/* the title lives in the page header; this row carries the context and actions */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        {href && (
          <a href={href} target="_blank" className="text-muted-foreground hover:text-foreground" aria-label={`${title} on GitHub`}>
            <ExternalLink className="size-4" />
          </a>
        )}
      </div>
      {check && onCheck && (
        <Button size="sm" variant="outline" onClick={onCheck} disabled={checking} title={checkedAt ? `Last checked ${ago(checkedAt)}` : undefined}>
          {checking ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
          {checking ? "Checking…" : "Check for updates"}
        </Button>
      )}
      {onUpdateAll && (
        <Button size="sm" onClick={onUpdateAll}>
          <ArrowUpCircle data-icon="inline-start" /> Update {updates!.length}
        </Button>
      )}
      {source && !source.listed && (
        <Button size="sm" variant="outline" onClick={pin}>
          <Pin data-icon="inline-start" /> Add to my sources
        </Button>
      )}
      {children}
      {(source?.listed || plugin) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" aria-label="More actions">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              {source?.listed && (
                <DropdownMenuItem onSelect={hide}>
                  <EyeOff /> Hide from my sources{source.installed ? " (keep its skills)" : ""}
                </DropdownMenuItem>
              )}
              {source?.listed && source.installed > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => confirm(`Remove ${source.repo}? Its ${source.installed} skills go to the archive (restorable).`) && (run("/api/sources/remove", { repo: source.repo }), onLeave?.())}
                  >
                    <Trash2 /> Remove source and its {source.installed} skills…
                  </DropdownMenuItem>
                </>
              )}
              {plugin && (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => confirm(`Uninstall ${plugin}? Disabling is enough if you might want it back.`) && run("/api/plugins/action", { id: plugin, action: "uninstall" })}
                >
                  <Trash2 /> Uninstall plugin…
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </header>
  );
}

type BundleProps = { label: string; on: boolean; disabled: boolean; hint?: string; change: Change };

/** The all-or-nothing rule: plugins and SATL namespaces get one switch for the whole set. */
function BundleSwitch({ label, on, disabled, hint, change, staged, applying, onToggle }: BundleProps & { staged: boolean; applying: boolean; onToggle: (undo: boolean) => void }) {
  const control = (
    <label className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
      <Switch checked={staged ? !on : on} disabled={disabled || applying} onCheckedChange={() => onToggle(staged)} />
      {label}
      {staged && <Badge variant="outline">pending</Badge>}
      {applying && <Spinner />}
    </label>
  );
  return hint ? (
    <Tooltip>
      <TooltipTrigger asChild>{control}</TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  ) : (
    control
  );
}

const STATUS: Record<NonNullable<Item["status"]>, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  // (an item with `fresh` also gets a "new" badge next to its status)
  update: { label: "update available", variant: "default" },
  moved: { label: "moved upstream", variant: "default" },
  gone: { label: "gone from repo", variant: "outline" },
  duplicate: { label: "duplicate", variant: "destructive" },
};

function SkillList({ items, effective, changes, applying, stage, usage, onOpen, bundled, showOrigin }: { items: Item[]; effective: (i: Item) => boolean; changes: Map<string, Change>; applying: Map<string, Change>; stage: (c: Change, undo: boolean) => void; usage: Record<string, Usage>; onOpen: (i: Item) => void; bundled: boolean; showOrigin: boolean }) {
  return (
    <div className="divide-y overflow-hidden rounded-lg border bg-card">
      {items.map((i) => {
        const on = effective(i);
        const c = i.change?.(i.installed);
        const staged = !!c && changes.has(changeKey(c));
        const busy = !!c && applying.has(changeKey(c));
        const u = i.usageKey ? usage[i.usageKey] : undefined;
        return (
          <div key={i.key} className={cn("flex items-start gap-3 px-4 py-2.5", !on && "text-muted-foreground", staged && "bg-accent/40")}>
            {i.change ? (
              <Checkbox className="mt-0.5" checked={on} disabled={busy} onCheckedChange={() => stage(c!, staged)} aria-label={`${on ? "Remove" : "Install"} ${i.name}`} />
            ) : i.takenBy ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="mt-0.5">
                    <Checkbox checked={false} disabled aria-label={`${i.name} can't be installed`} />
                  </span>
                </TooltipTrigger>
                <TooltipContent>Installing this would replace the {i.name} from {i.takenBy}. Remove that one first.</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", on ? "bg-primary" : "bg-muted-foreground/30")} aria-label={on ? "installed" : "not installed"} />
                </TooltipTrigger>
                <TooltipContent>{bundled ? "Part of a set: use the switch at the top" : "Comes from a plugin or SATL: manage it from its source"}</TooltipContent>
              </Tooltip>
            )}
            <button className="min-w-0 flex-1 text-left" onClick={() => onOpen(i)}>
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px] font-medium text-foreground hover:underline">{i.name}</span>
                {staged && <Badge variant="outline">will {verb(c, on)}</Badge>}
                {busy && (
                  <Badge variant="secondary" className="gap-1">
                    <Spinner /> {verb(c, on).replace(/e$/, "")}ing
                  </Badge>
                )}
                {i.status && <Badge variant={STATUS[i.status].variant}>{STATUS[i.status].label}</Badge>}
                {i.fresh && <Badge variant="outline" className="border-primary text-primary">new</Badge>}
                {i.takenBy && <Badge variant="outline">name used by {i.takenBy}</Badge>}
                {showOrigin && <span className="text-xs text-muted-foreground">{i.drawer.origin}</span>}
              </span>
              <span className="line-clamp-1 text-xs text-muted-foreground">{i.description || "No description"}</span>
            </button>
            <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground tabular sm:block">
              {i.context ? (i.context.listing ? `~${fmtTokens(i.context.listing)}` : "hidden") : ""}
            </span>
            <span className="hidden w-16 shrink-0 text-right text-xs text-muted-foreground tabular sm:block">{u ? `${uses(u)} uses` : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

function Duplicates({ groups, changes, stage, onOpen }: { groups: [string, Skill[]][]; changes: Map<string, Change>; stage: (c: Change, undo: boolean) => void; onOpen: (s: Skill) => void }) {
  if (!groups.length)
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No duplicates</EmptyTitle>
          <EmptyDescription>Every skill is installed exactly once.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <div className="flex flex-col gap-3">
      <Header title="Duplicates" subtitle="The same skill name installed from more than one place. Claude lists each copy. Keep one, remove the rest." />
      {groups.map(([name, copies]) => {
        const same = new Set(copies.map((c) => c.description)).size === 1;
        return (
          <section key={name} className="overflow-hidden rounded-lg border bg-card">
            <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2">
              <span className="font-mono text-[13px] font-medium">{name}</span>
              <Badge variant={same ? "destructive" : "outline"}>{same ? "identical copies" : "same name, different content"}</Badge>
            </div>
            {copies.map((s) => {
              const removable = !s.plugin;
              const c: Change = s.origin.kind === "github" ? { type: "npx-remove", name: s.name } : { type: "remove-path", name: s.name, path: s.path };
              const staged = removable && changes.has(changeKey(c));
              return (
                <div key={s.path} className={cn("flex items-center gap-3 px-4 py-2", staged && "bg-accent/40 text-muted-foreground line-through")}>
                  <button className="min-w-0 flex-1 text-left" onClick={() => onOpen(s)}>
                    <span className="block text-sm">{ORIGIN(s)}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{s.path.replace(/^\/Users\/[^/]+/, "~")}</span>
                  </button>
                  {removable ? (
                    <Button size="sm" variant={staged ? "ghost" : "outline"} onClick={() => stage(c, staged)}>
                      {staged ? "Keep" : "Remove this copy"}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">disable the plugin to drop it</span>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

/** Two panes in the same visual language as every other list: teams & people (each with its whole-set switch) | the focused one's skills. */
function SatlBrowse({
  catalog,
  isInstalled,
  skillOn,
  effective,
  changes,
  applying,
  stage,
  project,
  initialized,
  status,
  usage,
  onOpenSkill,
}: {
  catalog: Namespace[];
  isInstalled: (t: string) => boolean;
  skillOn: (ns: string, id: string) => boolean;
  effective: (i: Item) => boolean;
  changes: Map<string, Change>;
  applying: Map<string, Change>;
  stage: (c: Change, undo: boolean) => void;
  project?: string;
  initialized: boolean;
  status: SatlStatus | null;
  usage: Record<string, Usage>;
  onOpenSkill: (s: Namespace["skills"][number], token: string) => void;
}) {
  const { run, isPending } = useJobs();
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [behind, setBehind] = useState<number | null>(status?.clone.behind ?? null);
  useEffect(() => setBehind(status?.clone.behind ?? null), [status]);
  const syncing = isPending("Pull SATL and sync");
  const check = async () => {
    setChecking(true);
    try {
      const s = await get<SatlStatus>(`/api/satl/status?project=${encodeURIComponent(project ?? "")}&fetch`);
      setBehind(s.clone.behind);
      toast.success(s.clone.behind ? `Knowledge base is ${s.clone.behind} commits behind` : "Knowledge base is up to date");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  const blocked = !project ? "Pick a repo first: SATL installs per repo." : !initialized ? "This repo has no satl.json yet (run satl init there)." : null;
  const shown = catalog.filter((n) => `${n.token} ${n.skills.map((s) => s.name).join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const ns = catalog.find((n) => n.token === focused) ?? shown[0];
  const nsItems: Item[] = (ns?.skills ?? []).map((s) => ({
    key: s.path,
    name: s.name,
    description: s.description,
    installed: skillOn(ns!.token, s.id),
    change: blocked ? undefined : (on) => ({ type: "satl", token: `${ns!.token}/skills/${s.id}`, include: !on }),
    drawer: { name: s.name, description: s.description, origin: `SATL · ${ns!.token}`, path: s.path, installed: skillOn(ns!.token, s.id) },
  }));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search teams, people or skills" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {project && (
          <>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {syncing ? (
                <>
                  <Spinner /> Pulling and syncing…
                </>
              ) : behind ? (
                `Knowledge base ${behind} commits behind`
              ) : (
                "Knowledge base up to date"
              )}
            </span>
            <Button variant="outline" onClick={check} disabled={checking || syncing}>
              {checking ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />} {checking ? "Checking…" : "Check"}
            </Button>
            {!!behind && !syncing && (
              <Button onClick={() => run("/api/satl/sync", { project })}>
                <GitPullRequestArrow data-icon="inline-start" /> Pull and sync
              </Button>
            )}
          </>
        )}
      </div>
      {blocked && (
        <Alert>
          <AlertDescription>{blocked}</AlertDescription>
        </Alert>
      )}

      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card md:h-[calc(100vh-11rem)]">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {(["team", "user"] as const).map((scope) => (
              <div key={scope}>
                <p className="sticky top-0 z-10 border-b bg-muted/60 px-4 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur">{scope === "team" ? "Teams" : "People"}</p>
                <div className="divide-y">
                  {shown
                    .filter((n) => n.token.startsWith(`${scope}/`))
                    .map((n) => {
                      const installed = isInstalled(n.token);
                      const c: Change = { type: "satl", token: n.token, include: !installed };
                      const staged = changes.has(changeKey(c));
                      const busy = applying.has(`satl:${n.token}`);
                      return (
                        <div key={n.token} className={cn("flex items-center gap-3 px-4 py-2.5", ns?.token === n.token ? "bg-accent text-accent-foreground" : staged && "bg-accent/40")}>
                          <Switch checked={staged ? !installed : installed} disabled={!!blocked || busy} onCheckedChange={() => stage(c, staged)} aria-label={`Install ${n.token}`} />
                          <button className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm" onClick={() => setFocused(n.token)}>
                            <span className="truncate">{n.token.split("/")[1]}</span>
                            {busy && <Spinner />}
                            {staged && <Badge variant="outline">pending</Badge>}
                            <span className="ml-auto text-xs text-muted-foreground tabular">{n.skills.length}</span>
                            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                          </button>
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col gap-3 md:h-[calc(100vh-11rem)]">
          {ns ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{ns.token}</span>
                <span className="text-sm text-muted-foreground">
                  {Object.entries(ns.counts)
                    .filter(([, n]) => n)
                    .map(([k, n]) => `${n} ${k}`)
                    .join(" · ") || "empty"}
                </span>
                <span className="flex-1" />
                <Badge variant={isInstalled(ns.token) ? "default" : "outline"}>{isInstalled(ns.token) ? "installed in this repo" : "not installed"}</Badge>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {nsItems.length ? (
                  <SkillList items={nsItems} effective={effective} changes={changes} applying={applying} stage={stage} usage={usage} onOpen={(i) => onOpenSkill(ns.skills.find((s) => s.path === i.key)!, ns.token)} bundled showOrigin={false} />
                ) : (
                  <Empty className="border">
                    <EmptyHeader>
                      <EmptyTitle>No skills</EmptyTitle>
                      <EmptyDescription>{ns.token} only ships rules, commands or agents.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </div>
            </>
          ) : (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>Pick a team or person</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>
    </div>
  );
}

/** What a plugin loads besides skills, from its manifest and marketplace entry. */
function Inventory({ c }: { c: Plugin["components"] }) {
  const parts = Object.entries({ skills: c.skills, commands: c.commands, agents: c.agents, hooks: c.hooks, "MCP servers": c.mcp, "LSP servers": c.lsp }).filter(([, n]) => n);
  if (!parts.length)
    return (
      <Alert variant="destructive">
        <AlertTitle>This plugin loads nothing</AlertTitle>
        <AlertDescription>
          No skills, commands, agents, hooks, MCP or LSP servers. Usually a packaging mistake upstream (the real plugin lives in a subfolder). It costs nothing, but you can disable or uninstall it.
        </AlertDescription>
      </Alert>
    );
  return (
    <div className="flex flex-wrap gap-1.5">
      {parts.map(([k, n]) => (
        <Badge key={k} variant="secondary" className="font-normal">
          {n} {k}
        </Badge>
      ))}
    </div>
  );
}

/** skills.sh results grouped by repo; opening one shows everything that repo offers. */
function SearchResults({ q, onOpen }: { q: string; onOpen: (repo: string) => void }) {
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setHits(null);
    setError(null);
    get<{ skills: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`).then((r) => setHits(r.skills), (e) => setError(e.message));
  }, [q]);
  const byRepo = [...Map.groupBy(hits ?? [], (h) => h.source)];
  return (
    <div className="flex flex-col gap-3">
      <Header title={`“${q}” on skills.sh`} subtitle="Open a repo to see all its skills and pick the ones you want." />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!hits && !error && <Spinner />}
      {hits && !byRepo.length && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Nothing found</EmptyTitle>
            <EmptyDescription>Try another word, or paste owner/repo in the npx search box.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <div className="divide-y overflow-hidden rounded-lg border bg-card">
        {byRepo.map(([repo, list]) => (
          <button key={repo} onClick={() => onOpen(repo)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/40">
            <Download className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{repo}</span>
              <span className="block truncate text-xs text-muted-foreground">{list.map((h) => h.name).join(", ")}</span>
            </span>
            <span className="text-xs text-muted-foreground tabular">{Math.max(...list.map((h) => h.installs)).toLocaleString()} installs</span>
          </button>
        ))}
      </div>
    </div>
  );
}
