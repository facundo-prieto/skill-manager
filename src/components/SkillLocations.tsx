import { useEffect, useState } from "react";
import { Link2, Loader2, Puzzle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { get, type Location } from "@/lib/api";
import { useJobs } from "@/lib/jobs";

type Found = { locations: Location[]; npxSource?: string };
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, "~").replace(/\/SKILL\.md$/, "");

export function useLocations(name: string | null, project?: string) {
  const { revision } = useJobs();
  const [found, setFound] = useState<Found | null>(null);
  useEffect(() => {
    setFound(null);
    if (name) void get<Found>(`/api/locations?name=${encodeURIComponent(name)}&project=${encodeURIComponent(project ?? "")}`).then(setFound);
  }, [name, project, revision]);
  return found;
}

function Where({ l }: { l: Location }) {
  return (
    <span className="min-w-0">
      <span className="flex items-center gap-1.5 text-sm">
        {l.kind === "plugin" ? <Puzzle className="size-3.5 text-primary" /> : l.kind === "symlink" && <Link2 className="size-3.5 text-muted-foreground" />}
        {l.kind === "plugin" ? `Plugin ${l.plugin}` : l.where}
      </span>
      <span className="block truncate font-mono text-xs text-muted-foreground" title={l.path}>
        {tilde(l.path)}
        {l.linkTarget && ` → ${l.linkTarget}`}
      </span>
    </span>
  );
}

/** Read-only list of every place a skill lives — shown when a skill row is expanded. */
export function LocationList({ name, project }: { name: string; project?: string }) {
  const found = useLocations(name, project);
  if (!found) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  return (
    <div className="space-y-1.5">
      {found.locations.map((l) => (
        <Where key={l.path} l={l} />
      ))}
      {found.npxSource && <p className="text-xs text-muted-foreground">Tracked by npx skills, from {found.npxSource}</p>}
    </div>
  );
}

/** Pick which copies to remove. Every copy goes to the archive (restorable); plugin copies point to the Plugins tab. */
export function RemoveDialog({ name, project, onClose }: { name: string | null; project?: string; onClose: () => void }) {
  const found = useLocations(name, project);
  const { run } = useJobs();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const removable = found?.locations.filter((l) => l.kind !== "plugin") ?? [];
  const plugins = found?.locations.filter((l) => l.kind === "plugin") ?? [];
  useEffect(() => setPicked(new Set(removable.map((l) => l.path))), [found]); // default: everywhere

  const toggle = (p: string) => setPicked((s) => (s.has(p) ? (s.delete(p), new Set(s)) : new Set(s.add(p))));
  const confirm = async () => {
    if (await run("/api/remove-everywhere", { name, paths: [...picked], project })) onClose();
  };

  return (
    <Dialog open={!!name} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Remove {name}</DialogTitle>
          <DialogDescription>Choose where to remove it from. Each copy is moved to the archive, so you can restore it from the Archive tab.</DialogDescription>
        </DialogHeader>
        {!found ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <div className="space-y-3">
            {removable.length === 0 && <p className="text-sm text-muted-foreground">No copies on disk to remove.</p>}
            {removable.map((l) => (
              <label key={l.path} className="flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 hover:bg-muted/40">
                <Checkbox className="mt-0.5" checked={picked.has(l.path)} onCheckedChange={() => toggle(l.path)} />
                <Where l={l} />
              </label>
            ))}
            {plugins.map((l) => (
              <div key={l.path} className="flex items-start gap-3 rounded-md border border-dashed px-3 py-2">
                <Where l={l} />
              </div>
            ))}
            {plugins.length > 0 && <p className="text-xs text-muted-foreground">Plugin copies come and go with their plugin: disable it in the Plugins tab.</p>}
            {found.npxSource && (
              <p className="text-xs text-muted-foreground">
                Installed with npx skills from {found.npxSource}. Its lock entry is dropped once no copy is left, so it won't come back on update.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!picked.size} onClick={confirm}>
            Remove from {picked.size} {picked.size === 1 ? "place" : "places"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
