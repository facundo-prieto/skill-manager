import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ChevronRight, CircleAlert, Info, Loader2, RefreshCw, Stethoscope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { type Finding, type Fix } from "@/lib/api";
import { useJobs } from "@/lib/jobs";

type Props = {
  findings: Finding[] | null;
  refresh: () => Promise<void>;
  onChanged: () => void;
  turnOff: (keys: string[]) => void;
};

const SEVERITY = {
  problem: { icon: CircleAlert, className: "text-destructive", label: "Problem" },
  warning: { icon: AlertTriangle, className: "text-amber-600 dark:text-amber-400", label: "Worth fixing" },
  info: { icon: Info, className: "text-muted-foreground", label: "FYI" },
} as const;

const KIND_LABEL = { local: "Yours", link: "Linked", github: "npx skills", satl: "SATL", plugin: "Plugin" } as const;

// fixes that delete or switch installers get a confirmation step; archive and turn-off are easy to undo
const needsConfirm = (f: Fix) => f.type === "npx-forget" || f.type === "switch-to-npx" || f.type === "npx-remove" || f.type === "add-to-claude";

/** Health checks over the whole setup, each with the fix that resolves it. */
export function DoctorView({ findings, refresh, turnOff }: Props) {
  const { run } = useJobs();
  // fixes already handed to the queue; cleared when findings refresh after a job finishes
  const [queued, setQueued] = useState<Set<string>>(new Set());
  useEffect(() => setQueued(new Set()), [findings]);
  const [confirming, setConfirming] = useState<{ finding: Finding; fix: Finding["fixes"][number] } | null>(null);
  const [checking, setChecking] = useState(false);

  const recheck = async () => (setChecking(true), await refresh(), setChecking(false));
  const apply = async (finding: Finding, option: Finding["fixes"][number]) => {
    if (option.fix.type === "turn-off") {
      turnOff(option.fix.keys);
      toast.success(`Turned off ${option.fix.keys.length} skills in the launch command`);
      return;
    }
    if (await run("/api/doctor/fix", { fix: option.fix })) setQueued((q) => new Set(q).add(`${finding.id}:${option.label}`));
  };

  if (!findings)
    return (
      <p className="flex items-center justify-center gap-2 rounded-lg border px-4 py-10 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Checking your skills…
      </p>
    );

  const counts = Object.fromEntries((["problem", "warning", "info"] as const).map((s) => [s, findings.filter((f) => f.severity === s).length]));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Stethoscope className="size-5 text-muted-foreground" />
        <p className="flex-1 text-sm">
          {counts.problem || counts.warning
            ? `${counts.problem} ${counts.problem === 1 ? "problem" : "problems"} and ${counts.warning} ${counts.warning === 1 ? "thing" : "things"} worth fixing.`
            : "Nothing to fix. Your skills are in good shape."}
          <span className="text-muted-foreground"> Checked duplicates, upstream changes, unused skills and stray files, without starting Claude.</span>
        </p>
        <Button variant="outline" onClick={recheck} disabled={checking}>
          {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check again
        </Button>
      </div>

      <div className="space-y-3">
        {findings.map((f) => (
          <FindingCard key={f.id} finding={f} queued={queued} onFix={(option) => (needsConfirm(option.fix) ? setConfirming({ finding: f, fix: option }) : apply(f, option))} />
        ))}
      </div>

      <AlertDialog open={!!confirming} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirming?.fix.label}?</AlertDialogTitle>
            <AlertDialogDescription>{confirming?.fix.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirming && apply(confirming.finding, confirming.fix)}>{confirming?.fix.label}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FindingCard({ finding: f, queued, onFix }: { finding: Finding; queued: Set<string>; onFix: (option: Finding["fixes"][number]) => void }) {
  const [open, setOpen] = useState(f.severity === "problem");
  const sev = SEVERITY[f.severity];
  const Icon = sev.icon;
  const count = f.copies?.length ?? f.items?.length ?? 0;

  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-start gap-3 px-4 py-3">
        <Icon className={cn("mt-0.5 size-5 shrink-0", sev.className)} aria-label={sev.label} />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{f.title}</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">{f.detail}</p>
          {count > 0 && (
            <button onClick={() => setOpen(!open)} className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
              {open ? "Hide" : "Show"} {count} {f.copies ? "skills" : "items"}
            </button>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {f.fixes.map((option) => {
            const isQueued = queued.has(`${f.id}:${option.label}`);
            return (
              <Button key={option.label} size="sm" variant={option.recommended ? "default" : "outline"} disabled={isQueued} onClick={() => onFix(option)} title={option.description}>
                {isQueued && <Loader2 className="animate-spin" />} {isQueued ? "Queued" : option.label}
              </Button>
            );
          })}
        </div>
      </div>

      {open && f.copies && (
        <div className="border-t">
          <div className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] gap-x-4 bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground">
            <span>Skill</span>
            <span>Installed by</span>
          </div>
          {f.copies.map((row) => (
            <div key={row[0]!.path} className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] items-center gap-x-4 border-t px-4 py-2">
              <span className="truncate font-mono text-[13px]">{row[0]!.name.split(":").pop()}</span>
              <span className="flex flex-wrap gap-1.5">
                {row.map((c) => (
                  <Badge key={c.path} variant="secondary" className="font-normal" title={c.path}>
                    {KIND_LABEL[c.kind]}: {c.kind === "local" ? (c.scope === "project" ? "this repo" : "~/.claude/skills") : c.origin}
                  </Badge>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
      {open && f.items && (
        <ul className="max-h-64 overflow-y-auto border-t px-4 py-2 font-mono text-xs leading-6 text-muted-foreground">
          {f.items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
