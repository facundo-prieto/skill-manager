import { useState } from "react";
import { toast } from "sonner";
import { RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { post, type Archived } from "@/lib/api";

/** Skills moved out of Claude's reach into ~/.claude/skills-archive. */
export function ArchiveView({ items, onChanged }: { items: Archived[]; onChanged: () => void }) {
  const [deleting, setDeleting] = useState<Archived | null>(null);
  const act = async (url: string, body: object, done: string) => {
    try {
      await post(url, body);
      toast.success(done);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const display = (a: Archived) => a.name.replace(/-\d{13}$/, "");

  if (!items.length)
    return (
      <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
        Nothing archived. Archive a skill from its ⋯ menu to take it out of every session without losing it.
      </p>
    );

  return (
    <>
      <div className="divide-y overflow-hidden rounded-lg border bg-card">
        {items.map((a) => (
          <div key={a.name} className="flex items-center gap-4 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[13px] font-medium">{display(a)}</p>
              <p className="truncate text-xs text-muted-foreground" title={a.original}>
                Was in {a.original.replace(/^\/Users\/[^/]+/, "~")}
              </p>
            </div>
            <span className="text-xs text-muted-foreground tabular">{a.archivedAt.slice(0, 10)}</span>
            <Button variant="outline" size="sm" onClick={() => act("/api/restore", { name: a.name }, `Restored ${display(a)}`)}>
              <RotateCcw /> Restore
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setDeleting(a)} aria-label={`Delete ${display(a)} for good`}>
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting && display(deleting)} for good?</AlertDialogTitle>
            <AlertDialogDescription>This is the only backup. Once deleted it can't be restored.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => act("/api/delete", { archived: deleting!.name }, `Deleted ${display(deleting!)}`)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
