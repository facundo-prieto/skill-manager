import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronsUpDown, FolderGit2, FolderPlus, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { get, post, type Repo } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Picks the repo to scan: the repos `abc` manages, ones you added, global-only, or any path typed into the search box. */
export function RepoPicker({ value, onChange, className }: { value?: string; onChange: (path?: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [query, setQuery] = useState("");
  const load = () => get<Repo[]>("/api/repos").then(setRepos);
  useEffect(() => void load(), []);
  useEffect(() => void (open && load()), [open]); // Settings may have added or removed repos meanwhile
  const save = async (path: string) => {
    try {
      const { repos: saved } = await get<{ repos: string[] }>("/api/config");
      await post("/api/config", { repos: [...saved, path] });
      toast.success("Added to your repos");
      await load();
      pick(path);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const groups = [
    { heading: "Repos from abc", list: repos.filter((r) => !r.manual) },
    { heading: "Added by you", list: repos.filter((r) => r.manual) },
  ].filter((g) => g.list.length);

  const current = repos.find((r) => r.path === value);
  const label = !value ? "Global skills only" : (current?.name ?? value.replace(/^\/Users\/[^/]+/, "~"));
  const pick = (path?: string) => (onChange(path), setOpen(false), setQuery(""));
  const looksLikePath = /^[~/]/.test(query);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className={cn("w-72 justify-between font-normal", className)}>
          <span className="flex min-w-0 items-center gap-2">
            {value ? <FolderGit2 className="size-4 shrink-0 text-muted-foreground" /> : <Globe className="size-4 shrink-0 text-muted-foreground" />}
            <span className="truncate">{label}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="end">
        <Command>
          <CommandInput placeholder="Search repos or type a path…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{looksLikePath ? null : "No repo matches. Type a path starting with ~ or /."}</CommandEmpty>
            {looksLikePath && (
              <CommandGroup heading="Path">
                <CommandItem value={query} onSelect={() => pick(query)}>
                  <FolderGit2 className="size-4" /> Scan {query} once
                </CommandItem>
                <CommandItem value={`save ${query}`} onSelect={() => save(query)}>
                  <FolderPlus className="size-4" /> Add {query} to my repos
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup>
              <CommandItem value="global skills only" onSelect={() => pick(undefined)}>
                <Globe className="size-4" /> Global skills only
                {!value && <Check className="ml-auto size-4" />}
              </CommandItem>
            </CommandGroup>
            {groups.map((g) => (
            <CommandGroup key={g.heading} heading={g.heading}>
              {g.list.map((r) => (
                <CommandItem key={r.path} value={r.name} onSelect={() => pick(r.path)}>
                  <FolderGit2 className="size-4" />
                  <span className="truncate">{r.name}</span>
                  <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground tabular">
                    {r.satl && <span>SATL</span>}
                    {r.skills > 0 && <span>{r.skills} skills</span>}
                    {r.path === value && <Check className="size-4 text-foreground" />}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            ))}
            {!repos.length && !looksLikePath && <p className="px-3 py-2 text-xs text-muted-foreground">No repos found. Type a path above, or add repos in Settings.</p>}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
