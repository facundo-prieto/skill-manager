import { useState } from "react";
import { Check, Copy, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { buildCommand, fmtTokens, keyOf, sum, type Skill } from "@/lib/api";

/** Top-bar version of the launch dock: what the next session loads, and the command to start it. */
export function LaunchSummary({ skills, off, project }: { skills: Skill[]; off: Set<string>; project?: string }) {
  const [copied, setCopied] = useState(false);
  const on = skills.filter((s) => !off.has(keyOf(s)));
  const command = buildCommand(skills, off, project);
  const plugins = skills.filter((s) => s.plugin).length;
  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex items-center gap-1">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="tabular" title="What the next session loads">
            <Rocket data-icon="inline-start" />
            {on.length}/{skills.length} · ~{fmtTokens(sum(on, "listingTokens"))} tok
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="flex w-[28rem] flex-col gap-2">
          <p className="text-sm font-medium">Next session</p>
          <p className="text-xs text-muted-foreground">
            {on.length} of {skills.length} skills on ({skills.length - plugins} folders, {plugins} from plugins) · about {fmtTokens(sum(on, "listingTokens"))} tokens of skill listing in every
            session. Turn skills off under Views → Next session.
          </p>
          <code className="max-h-40 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs break-all">{command}</code>
        </PopoverContent>
      </Popover>
      <Button size="sm" onClick={copy}>
        {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
        {copied ? "Copied" : "Copy command"}
      </Button>
    </div>
  );
}
