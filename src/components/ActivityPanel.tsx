import { CheckCircle2, CircleDashed, ListTodo, Loader2, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { useJobs, type Job } from "@/lib/jobs";

const ICON = {
  queued: <CircleDashed className="size-4 text-muted-foreground" />,
  running: <Loader2 className="size-4 animate-spin text-primary" />,
  done: <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />,
  failed: <XCircle className="size-4 text-destructive" />,
};

/** Header button + popover listing the job queue: what's running, what's next, what finished. */
export function ActivityPanel() {
  const { jobs, clear } = useJobs();
  const running = jobs.filter((j) => j.status === "running" || j.status === "queued");
  const failed = jobs.filter((j) => j.status === "failed").length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="gap-2">
          {running.length ? <Loader2 className="animate-spin" /> : <ListTodo />}
          {running.length ? `${running.length} in progress` : "Activity"}
          {failed > 0 && !running.length && <span className="rounded-full bg-destructive px-1.5 text-[11px] text-white tabular">{failed}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <span className="text-sm font-medium">Activity</span>
          {jobs.some((j) => j.finishedAt) && (
            <Button variant="ghost" size="sm" onClick={() => clear()}>
              Clear finished
            </Button>
          )}
        </div>
        <div className="max-h-96 divide-y overflow-y-auto">
          {jobs.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted-foreground">Installs, updates and fixes you start show up here.</p>}
          {jobs.map((j) => (
            <JobRow key={j.id} job={j} onDismiss={() => clear(j.id)} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function JobRow({ job: j, onDismiss }: { job: Job; onDismiss: () => void }) {
  const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
  return (
    <div className="space-y-1.5 px-4 py-3">
      <div className="flex items-center gap-2">
        {ICON[j.status]}
        <span className="min-w-0 flex-1 truncate text-sm">{j.label}</span>
        {j.total > 1 && <span className="text-xs text-muted-foreground tabular">{j.done}/{j.total}</span>}
        {j.finishedAt && (
          <Button variant="ghost" size="icon" className="size-6" onClick={onDismiss} aria-label={`Dismiss ${j.label}`}>
            <X />
          </Button>
        )}
      </div>
      {j.status === "running" && (
        <>
          <Progress value={j.total > 1 ? pct : undefined} className="h-1" />
          {j.step && <p className="truncate text-xs text-muted-foreground">{j.step}…</p>}
        </>
      )}
      {j.status === "queued" && <p className="text-xs text-muted-foreground">Waiting for the job before it</p>}
      {j.status === "failed" && <p className="text-xs break-words text-destructive">{j.error}</p>}
      {j.log.length > 0 && <p className="text-xs break-words text-muted-foreground">{j.log.join(" · ")}</p>}
    </div>
  );
}
