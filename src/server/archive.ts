import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { AGENTS } from "./agents";

const ARCHIVE = join(homedir(), ".claude/skills-archive"); // outside every scanned skills dir, so archived = gone from Claude

export type Archived = { name: string; original: string; archivedAt: string };

/** The skill dir behind a SKILL.md path, only if it sits directly in an agent's skills dir or a repo's .claude/skills — guards every rm below. */
function skillDir(skillMd: string) {
  const dir = dirname(resolve(skillMd));
  const parent = dirname(dir);
  const allowed = parent.endsWith("/.claude/skills") || AGENTS.some((a) => a.dir === parent);
  if (basename(skillMd) !== "SKILL.md" || !allowed || !existsSync(skillMd)) throw new Error(`Not a user/project skill: ${skillMd}`);
  return dir;
}

export function archive(skillMd: string) {
  const dir = skillDir(skillMd);
  let dest = join(ARCHIVE, `${basename(dir)}-${Date.now()}`);
  for (let i = 2; existsSync(dest); i++) dest = join(ARCHIVE, `${basename(dir)}-${Date.now()}-${i}`); // same skill from several agents in one go
  mkdirSync(ARCHIVE, { recursive: true });
  // dereference: `npx skills` installs are symlinks into ~/.agents/skills, archive the real content
  cpSync(dir, dest, { recursive: true, dereference: true });
  writeFileSync(join(dest, ".archive.json"), JSON.stringify({ original: dir, archivedAt: new Date().toISOString() }));
  rmSync(dir, { recursive: true }); // on a symlink this removes the link only
}

export function listArchive(): Archived[] {
  if (!existsSync(ARCHIVE)) return [];
  return readdirSync(ARCHIVE)
    .filter((d) => existsSync(join(ARCHIVE, d, ".archive.json")))
    .map((d) => ({ name: d, ...JSON.parse(readFileSync(join(ARCHIVE, d, ".archive.json"), "utf8")) }));
}

function archivedDir(name: string) {
  const dir = join(ARCHIVE, basename(name)); // basename: no ../ escapes
  if (!existsSync(join(dir, ".archive.json"))) throw new Error(`Not in archive: ${name}`);
  return dir;
}

export function restore(name: string) {
  const dir = archivedDir(name);
  const { original } = JSON.parse(readFileSync(join(dir, ".archive.json"), "utf8"));
  if (existsSync(original)) throw new Error(`Something already lives at ${original}`);
  cpSync(dir, original, { recursive: true, filter: (src) => basename(src) !== ".archive.json" });
  rmSync(dir, { recursive: true });
}

/** Permanent. Works on an archived entry or directly on a live skill. */
export function remove(target: { archived?: string; skillMd?: string }) {
  const dir = target.archived ? archivedDir(target.archived) : skillDir(target.skillMd!);
  rmSync(dir, { recursive: true, force: lstatSync(dir).isSymbolicLink() });
}
