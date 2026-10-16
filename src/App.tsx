import { useEffect, useState } from "react";
import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { RepoPicker } from "@/components/RepoPicker";
import { ActivityPanel } from "@/components/ActivityPanel";
import { ThemeToggle } from "@/components/ThemeToggle";
import { JobsProvider } from "@/lib/jobs";
import { LaunchSummary } from "@/components/LaunchSummary";
import { AgentsView } from "@/views/AgentsView";
import { LibraryView } from "@/views/library/LibraryView";
import { ArchiveView } from "@/views/ArchiveView";
import { get, type Archived, type Finding, type Skill, type UpdateStatus, type Usage } from "@/lib/api";

const initialProject = new URLSearchParams(location.search).get("project") ?? undefined;

export function App() {
  const [project, setProject] = useState<string | undefined>(initialProject);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [off, setOffState] = useState<Set<string>>(new Set());
  const [usage, setUsage] = useState<Record<string, Usage>>({});
  const [archived, setArchived] = useState<Archived[]>([]);
  const [updates, setUpdates] = useState<UpdateStatus[] | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const storageKey = `skill-manager:off:${project ?? "~"}`; // selection is remembered per repo

  const load = async () => {
    try {
      const res = await get<{ project?: string; skills: Skill[] }>(`/api/skills?project=${encodeURIComponent(project ?? "")}`);
      setSkills(res.skills);
      setArchived(await get<Archived[]>("/api/archive"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const refreshDoctor = async () => {
    try {
      setFindings(await get<Finding[]>(`/api/doctor?project=${encodeURIComponent(project ?? "")}`));
    } catch (e) {
      toast.error(`Doctor failed: ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    void load();
    void refreshDoctor();
    history.replaceState(null, "", project ? `?project=${encodeURIComponent(project)}` : "/");
  }, [project]);
  useEffect(() => setOffState(new Set(JSON.parse(localStorage.getItem(storageKey) ?? "[]"))), [storageKey]);
  /** Re-check npx installs against GitHub. `source` checks one repo (merged into the rest); `fresh` skips the server cache. */
  const refreshUpdates = async (opts: { source?: string; fresh?: boolean } = {}) => {
    try {
      const q = new URLSearchParams({ ...(opts.source && { source: opts.source }), ...(opts.fresh && { fresh: "1" }) });
      const list = await get<UpdateStatus[]>(`/api/updates?${q}`);
      setUpdates((prev) => (opts.source ? [...(prev ?? []).filter((u) => u.source !== opts.source), ...list] : list));
      return list;
    } catch (e) {
      toast.error(`Update check failed: ${(e as Error).message}`);
      return [];
    }
  };
  useEffect(() => {
    void get<Record<string, Usage>>("/api/usage").then(setUsage);
    void refreshUpdates();
  }, []);
  const setOff = (next: Set<string>) => (setOffState(next), localStorage.setItem(storageKey, JSON.stringify([...next])));

  const issues = findings?.filter((f) => f.severity !== "info").length ?? 0;
  const pendingUpdates = updates?.filter((u) => u.inClaude && (u.status === "update" || u.status === "moved")).length ?? 0;

  const viewTitle = (title: string, subtitle: string, body: React.ReactNode) => (
    <div className="flex flex-col gap-3">
      <header>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </header>
      {body}
    </div>
  );

  return (
    <JobsProvider onFinished={() => (load(), refreshDoctor(), refreshUpdates())}>
      <TooltipProvider delayDuration={300}>
        <div className="min-h-screen">
            <LibraryView
              repoPicker={<RepoPicker value={project} onChange={setProject} className="w-full" />}
              topBar={
                <>
                  <LaunchSummary skills={skills} off={off} project={project} />
                  <ActivityPanel />
                  <ThemeToggle />
                </>
              }
              skills={skills}
              usage={usage}
              updates={updates}
              findings={findings}
              refreshDoctor={refreshDoctor}
              checkUpdates={(source) => refreshUpdates({ source, fresh: true })}
              turnOff={(keys) => setOff(new Set([...off, ...keys]))}
              project={project}
              onPickProject={setProject}
              onChanged={() => (load(), refreshDoctor(), refreshUpdates())}
              archivedCount={archived.length}
              sessionOff={off.size}
              off={off}
              setOff={setOff}
              extra={{
                agents: viewTitle("Agents", "Which agent (Claude Code, Codex, Cursor…) has each skill, and copies between them.", <AgentsView />),
                archive: viewTitle("Archive", "Skills taken out of every session, kept in ~/.claude/skills-archive so you can bring them back.", <ArchiveView items={archived} onChanged={load} />),
              }}
            />
        </div>
        <Toaster position="top-right" closeButton duration={3000} />
      </TooltipProvider>
    </JobsProvider>
  );
}
