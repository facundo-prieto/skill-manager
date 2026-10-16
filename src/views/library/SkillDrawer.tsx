import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Archive, Lock, PanelRightClose, PanelRightOpen, PencilLine, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LocationList } from "@/components/SkillLocations";
import { ago, fmtTokens, get, post, uses, type UpdateStatus, type Usage } from "@/lib/api";
import { RefreshCw } from "lucide-react";

/** What the drawer can show: an installed skill (path on disk) or one a repo offers but you haven't installed. */
export type DrawerSkill = {
  name: string; // as Claude lists it
  description: string;
  origin: string; // human-readable: "Yours", "npx · owner/repo", "Plugin · id", "SATL · team/x"
  path?: string; // local SKILL.md
  remote?: { repo: string; folder: string };
  installed: boolean;
  npxSource?: string; // installed with npx skills from this repo → can check for an update
  archivable?: boolean; // one of your own skills: can go to the archive from here
  listingTokens?: number;
  bodyTokens?: number;
};

type File = { content: string; editable: boolean; reason?: string };

/**
 * Quick view: docked to the right of the page, never modal — the rest of the app stays usable.
 * Collapses to a thin strip (keeps the skill) or closes.
 */
export function SkillDrawer({
  skill,
  usage,
  project,
  onClose,
  onSaved,
  update,
  onCheck,
  onArchive,
}: {
  skill: DrawerSkill | null;
  usage?: Usage;
  project?: string;
  onClose: () => void;
  onSaved: () => void;
  update?: UpdateStatus; // npx status for this skill, if known
  onCheck?: (source: string) => Promise<unknown>;
  onArchive?: (s: DrawerSkill) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setCollapsed(false), [skill?.name]);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null); // non-null = editing
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setFile(null);
    setError(null);
    setDraft(null);
    if (!skill) return;
    const q = skill.path
      ? `path=${encodeURIComponent(skill.path)}&project=${encodeURIComponent(project ?? "")}`
      : `repo=${encodeURIComponent(skill.remote!.repo)}&folder=${encodeURIComponent(skill.remote!.folder)}`;
    get<File>(`/api/skill-file?${q}`).then(setFile, (e) => setError(e.message));
  }, [skill?.path, skill?.remote?.repo, skill?.remote?.folder]);

  const save = async () => {
    setSaving(true);
    try {
      await post("/api/skill-file", { path: skill!.path, content: draft, project });
      toast.success(`Saved ${skill!.name}`, { description: "Previous version kept as .SKILL.md.bak" });
      setFile({ ...file!, content: draft! });
      setDraft(null);
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const dirty = draft !== null && draft !== file?.content;
  const close = () => (!dirty || confirm("Discard your unsaved edits?")) && onClose();

  if (!skill) return null;
  if (collapsed)
    return (
      <aside className="fixed top-12 right-0 z-30 flex h-[calc(100vh-3rem)] w-10 shrink-0 flex-col items-center gap-2 border-l bg-card py-2 xl:sticky xl:z-auto">
        <Button size="icon" variant="ghost" className="size-8" onClick={() => setCollapsed(false)} aria-label="Expand quick view">
          <PanelRightOpen />
        </Button>
        <span className="font-mono text-xs text-muted-foreground [writing-mode:vertical-rl]">{skill.name}</span>
      </aside>
    );

  return (
    // docked beside the content on wide screens; floats over it (still non-modal) when there isn't room
    <aside
      className="fixed top-12 right-0 z-30 flex h-[calc(100vh-3rem)] w-[min(30rem,92vw)] shrink-0 flex-col border-l bg-card shadow-xl xl:sticky xl:z-auto xl:shadow-none"
      aria-label={`Quick view of ${skill.name}`}
    >
        <div className="flex flex-col gap-1.5 border-b p-4">
          <div className="flex items-start gap-2">
            <h2 className="min-w-0 flex-1 truncate font-mono text-sm font-semibold">{skill.name}</h2>
            <Button size="icon" variant="ghost" className="size-7" onClick={() => setCollapsed(true)} aria-label="Collapse quick view">
              <PanelRightClose />
            </Button>
            <Button size="icon" variant="ghost" className="size-7" onClick={close} aria-label="Close quick view">
              <X />
            </Button>
          </div>
          <p className="line-clamp-4 text-xs text-muted-foreground">{skill.description || "No description"}</p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Badge variant="secondary">{skill?.origin}</Badge>
            {!skill?.installed && <Badge variant="outline">Not installed</Badge>}
            {skill?.listingTokens !== undefined && (
              <Badge variant="outline">
                ~{fmtTokens(skill.listingTokens)} always / {fmtTokens(skill.bodyTokens ?? 0)} when used
              </Badge>
            )}
            {usage && (
              <Badge variant="outline">
                used {uses(usage)}× · last {ago(usage.lastUsed)}
              </Badge>
            )}
            {skill.archivable && skill.path && onArchive && (
              <Button size="sm" variant="outline" className="ml-auto" disabled={dirty} onClick={() => onArchive(skill)} title="Moves it to ~/.claude/skills-archive. Restore or delete it for good from Archive.">
                <Archive data-icon="inline-start" /> Archive
              </Button>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {skill.npxSource && onCheck && (
            <section className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <span className="flex-1">
                {update?.status === "update"
                  ? "An update is available on GitHub."
                  : update?.status === "moved"
                    ? `Moved upstream to ${update.movedTo}.`
                    : update?.status === "removed"
                      ? `No longer in ${skill.npxSource}.`
                      : `Up to date with ${skill.npxSource}.`}
              </span>
              <Button size="sm" variant="outline" disabled={checking} onClick={async () => (setChecking(true), await onCheck(skill.npxSource!), setChecking(false))}>
                {checking ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />} Check now
              </Button>
            </section>
          )}
          {skill?.installed && (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Installed in</h3>
              <LocationList name={skill.name.split(":").pop()!} project={project} />
            </section>
          )}
          <Separator />
          <section className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-2">
              <h3 className="flex-1 text-sm font-medium">SKILL.md</h3>
              {file?.editable && draft === null && (
                <Button size="sm" variant="outline" onClick={() => setDraft(file.content)}>
                  <PencilLine data-icon="inline-start" /> Edit
                </Button>
              )}
              {draft !== null && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={saving}>
                    <X data-icon="inline-start" /> Cancel
                  </Button>
                  <Button size="sm" onClick={save} disabled={!dirty || saving}>
                    {saving ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />} Save
                  </Button>
                </>
              )}
            </div>
            {file && !file.editable && file.reason && (
              <Alert>
                <Lock />
                <AlertDescription>{file.reason}</AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {!file && !error && <Spinner />}
            {file &&
              (draft !== null ? (
                <Textarea className="min-h-[28rem] flex-1 font-mono text-xs leading-relaxed" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
              ) : (
                <pre className="flex-1 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{file.content}</pre>
              ))}
          </section>
        </div>
    </aside>
  );
}
