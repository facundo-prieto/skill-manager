import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, CircleAlert, FolderGit2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { get, post } from "@/lib/api";
import type { detect } from "@/server/config";

type Detected = ReturnType<typeof detect>;
const tilde = (p?: string) => p?.replace(/^\/Users\/[^/]+/, "~");
const SOURCE: Record<string, string> = { settings: "set here", env: "from $SATL_REPO_PATH", abc: "from abc's repo list", default: "found automatically" };

/** What the app found on this machine, and manual paths for whatever it couldn't find. */
export function SettingsView({ onSaved }: { onSaved: () => void }) {
  const [d, setD] = useState<Detected | null>(null);
  const load = () => get<Detected>("/api/config").then(setD, (e) => toast.error(e.message));
  useEffect(() => void load(), []);

  const save = async (patch: Record<string, unknown>, ok: string) => {
    try {
      setD(await post<Detected>("/api/config", patch));
      toast.success(ok);
      onSaved();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  };

  if (!d) return <Spinner />;
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Tools on this machine</CardTitle>
          <CardDescription>Looked up in your shell's PATH. Only Claude Code is required; the rest turn on their sections.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col divide-y">
          <Tool name="Claude Code" path={d.claude} need="Required: lists your plugins and checks what a session loads." install="npm i -g @anthropic-ai/claude-code" />
          <Tool name="npx (Node.js)" path={d.npx} need="Installs and updates skills from GitHub with npx skills." install="brew install node" />
          <Tool name="git" path={d.git} need="Checks your SATL clone for new commits." install="xcode-select --install" />
          <Tool name="abc" path={d.abc.cli} need="Optional: AuditBoard's dev CLI. Its config lists your repos." />
          <Tool name="satl" path={d.satl.cli} need="Optional: installs SATL team and people skills into a repo." />
        </CardContent>
      </Card>

      <PathSetting
        title="abc config"
        description={`Where your repos come from. ${d.abc.path ? `${d.abc.repos} repos listed.` : "Not found, so the repo picker only shows repos you add below."}`}
        found={d.abc.path}
        source={d.abc.source}
        placeholder="~/.config/abc/config.yml"
        onSave={(v) => save({ abcConfig: v }, v ? "abc config saved" : "Back to auto-detect")}
      />

      <PathSetting
        title="SATL knowledge base"
        description="Your clone of auditboard-satl (the folder that has knowledge-base/ in it). The SATL section needs it."
        found={d.satl.path}
        source={d.satl.source}
        placeholder="~/auditboard/repos/auditboard-satl"
        onSave={(v) => save({ satlRepo: v }, v ? "SATL path saved" : "Back to auto-detect")}
      />

      <ManualRepos repos={d.repos} onSave={(repos, ok) => save({ repos }, ok)} />
    </div>
  );
}

function Tool({ name, path, need, install }: { name: string; path?: string; need: string; install?: string }) {
  return (
    <div className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
      {path ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{name}</p>
        <p className="text-xs text-muted-foreground">{need}</p>
        {!path && install && <code className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{install}</code>}
      </div>
      {path ? (
        <span className="truncate font-mono text-xs text-muted-foreground" title={path}>
          {tilde(path)}
        </span>
      ) : (
        <Badge variant="outline">not found</Badge>
      )}
    </div>
  );
}

function PathSetting({ title, description, found, source, placeholder, onSave }: { title: string; description: string; found?: string; source: string | null; placeholder: string; onSave: (v: string) => Promise<boolean> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (v: string) => {
    setBusy(true);
    if (await onSave(v)) setValue("");
    setBusy(false);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {title}
          {found ? <Badge variant="secondary">{SOURCE[source ?? ""] ?? source}</Badge> : <Badge variant="outline">not found</Badge>}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {found && <p className="font-mono text-xs break-all">{tilde(found)}</p>}
        <form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), value.trim() && submit(value))}>
          <Input className="font-mono text-xs" placeholder={found ? `Use a different path, e.g. ${placeholder}` : placeholder} value={value} onChange={(e) => setValue(e.target.value)} aria-label={`${title} path`} />
          <Button type="submit" variant="outline" disabled={busy || !value.trim()}>
            {busy && <Spinner data-icon="inline-start" />} Save
          </Button>
        </form>
        {source === "settings" && (
          <Button variant="link" size="sm" className="self-start px-0" onClick={() => submit("")}>
            Forget this path and auto-detect again
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function ManualRepos({ repos, onSave }: { repos: string[]; onSave: (repos: string[], ok: string) => Promise<boolean> }) {
  const [value, setValue] = useState("");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Repos you added</CardTitle>
        <CardDescription>For repos abc doesn't know about. They show up in the repo picker; you can also add one there by typing its path.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {repos.map((r) => (
          <div key={r} className="flex items-center gap-2 rounded-md border px-3 py-1.5">
            <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{tilde(r)}</span>
            <Button variant="ghost" size="icon" className="size-6" aria-label={`Remove ${r}`} onClick={() => onSave(repos.filter((x) => x !== r), "Repo removed from the list")}>
              <X />
            </Button>
          </div>
        ))}
        <form className="flex gap-2" onSubmit={async (e) => (e.preventDefault(), value.trim() && (await onSave([...repos, value], "Repo added")) && setValue(""))}>
          <Input className="font-mono text-xs" placeholder="~/code/my-repo" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Repo path" />
          <Button type="submit" variant="outline" disabled={!value.trim()}>
            <Plus data-icon="inline-start" /> Add
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
