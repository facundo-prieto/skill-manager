import { join } from "node:path";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { AGENTS } from "./agents";
import { archive } from "./archive";
import { dropLockEntry, lockEntries } from "./npx";
import { scan } from "./scan";
import type { Progress } from "./jobs";

export type Location = {
  where: string; // agent label, "This repo" or "Plugin"
  path: string; // the SKILL.md
  kind: "folder" | "symlink" | "plugin";
  linkTarget?: string;
  plugin?: string;
};

const NAME = /^\w[\w.-]*$/;

/** Every place a skill with this name exists: each agent's folder, the scanned repo, and plugins that ship it. */
export function locations(name: string, project?: string): { locations: Location[]; npxSource?: string } {
  if (!NAME.test(name)) throw new Error("Bad skill name");
  const dirs = [...AGENTS.map((a) => ({ where: a.label, dir: a.dir })), ...(project ? [{ where: "This repo", dir: join(project, ".claude/skills") }] : [])];
  const found: Location[] = dirs.flatMap(({ where, dir }) => {
    const skillDir = join(dir, name);
    if (!existsSync(join(skillDir, "SKILL.md"))) return [];
    const link = lstatSync(skillDir).isSymbolicLink();
    return [{ where, path: join(skillDir, "SKILL.md"), kind: link ? ("symlink" as const) : ("folder" as const), ...(link && { linkTarget: readlinkSync(skillDir) }) }];
  });
  // a plugin copy can't be removed on its own — the UI points to the Plugins tab instead
  const plugins = scan(project)
    .filter((s) => s.plugin && s.name.split(":")[1] === name)
    .map((s): Location => ({ where: "Plugin", path: s.path, kind: "plugin", plugin: s.plugin }));
  return { locations: [...found, ...plugins], npxSource: lockEntries()[name]?.source };
}

/**
 * Remove a skill from the chosen places. Each copy is moved to the archive with its original path (restorable),
 * never deleted outright. Only paths that `locations()` reports for this name are accepted.
 */
export function removeEverywhere(name: string, paths: string[], project?: string, p?: Progress) {
  const { locations: all, npxSource } = locations(name, project);
  const removable = new Set(all.filter((l) => l.kind !== "plugin").map((l) => l.path));
  const bad = paths.filter((x) => !removable.has(x));
  if (!paths.length || bad.length) throw new Error(bad.length ? `Not a removable copy of ${name}: ${bad.join(", ")}` : "Nothing selected");
  p?.setTotal(paths.length + 1);
  // links first: archiving the folder a symlink points to would leave the link dangling
  const isLink = (x: string) => all.find((l) => l.path === x)?.kind === "symlink";
  for (const path of paths.toSorted((a, b) => Number(isLink(b)) - Number(isLink(a)))) {
    p?.step(`Archiving ${path.replace(/^\/Users\/[^/]+/, "~")}`);
    archive(path);
  }
  p?.step("Updating the npx skills lock");
  // the lock only goes once no folder copy is left anywhere — otherwise other agents still rely on it
  if (npxSource && !locations(name, project).locations.some((l) => l.kind !== "plugin")) dropLockEntry(name);
  return { archived: paths.length };
}
