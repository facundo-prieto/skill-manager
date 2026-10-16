import { homedir } from "node:os";
import { basename, join } from "node:path";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { pluginRepos, scan, type Skill } from "./scan";
import * as npx from "./npx";
import { usage } from "./usage";
import { archive } from "./archive";
import { addToClaude } from "./agents";
import { listPlugins, pluginAction } from "./plugins";
import type { Progress } from "./jobs";

/** What a fix does. The server re-validates every payload before running it. */
export type Fix =
  | { type: "npx-remove"; names: string[] } // Claude Code copies only
  | { type: "npx-forget"; names: string[] } // every agent + the npx lock entry
  | { type: "switch-to-npx"; plugin: string; source: string; names: string[] } // disable plugin, install what it gave you via npx
  | { type: "archive"; paths: string[] }
  | { type: "add-to-claude"; names: string[] }
  | { type: "plugin-disable"; ids: string[] } // reinstall npx ones from their repo, copy the rest from the newest agent copy
  | { type: "turn-off"; keys: string[] }; // launch selection only, applied in the browser

export type Copy = { name: string; origin: string; kind: Skill["origin"]["kind"]; path: string; scope: Skill["scope"] };

export type Finding = {
  id: string;
  severity: "problem" | "warning" | "info";
  title: string;
  detail: string;
  copies?: Copy[][]; // duplicates: one row per skill name, one entry per copy
  items?: string[];
  fixes: { label: string; description: string; fix: Fix; recommended?: boolean }[];
};

const baseName = (s: Skill) => (s.plugin ? s.name.split(":")[1]! : s.name);
const copyOf = (s: Skill): Copy => ({ name: s.name, origin: s.origin.label, kind: s.origin.kind, path: s.path, scope: s.scope });

function duplicates(skills: Skill[]): Finding[] {
  const groups = [...Map.groupBy(skills, baseName)].filter(([, list]) => list.length > 1);
  // cluster by which installers collide, so 27 mattpocock duplicates are one decision, not 27
  const byPair = Map.groupBy(groups, ([, list]) => [...new Set(list.map((s) => `${s.origin.kind}|${s.origin.label}`))].sort().join(" + "));
  return [...byPair].map(([pair, rows]): Finding => {
    const all = rows.flatMap(([, list]) => list);
    const identical = rows.filter(([, list]) => new Set(list.map((s) => s.description)).size === 1).length;
    const plugins = [...new Set(all.filter((s) => s.plugin).map((s) => s.plugin!))];
    // with two plugins in play "keep the plugin" is ambiguous, so only the npx side gets a one-click fix
    const plugin = plugins.length === 1 ? all.find((s) => s.plugin === plugins[0]) : undefined;
    const npxCopies = all.filter((s) => s.origin.kind === "github");
    const loose = all.filter((s) => s.origin.kind !== "plugin" && s.origin.kind !== "github" && s.scope !== "plugin");
    const labels = [...new Set(all.map((s) => s.origin.label))];
    const fixes: Finding["fixes"] = [];
    // switching installers only makes sense when the copies are the same skill; a shared name alone isn't enough
    if (plugin && npxCopies.length && identical === rows.length) {
      const source = npxCopies[0]!.origin.label;
      fixes.push({
        label: `Keep the plugin`,
        description: `Remove the ${npxCopies.length} copies installed with npx skills (Claude Code only). The plugin keeps providing them and updates with /plugin.`,
        fix: { type: "npx-remove", names: npxCopies.map((s) => s.name) },
        recommended: true,
      });
      fixes.push({
        label: `Keep npx skills`,
        description: `Disable ${plugin.plugin} and install everything it gave you from ${source} with npx skills, so you can pick skills one by one in Sources. Re-enable any time with /plugin.`,
        fix: { type: "switch-to-npx", plugin: plugin.plugin!, source, names: skills.filter((s) => s.plugin === plugin.plugin).map(baseName) },
      });
    }
    if (!plugin && plugins.length > 1 && npxCopies.length)
      fixes.push({
        label: "Remove the npx copies",
        description: `Keep the plugin versions (${plugins.join(", ")}) and drop the ${npxCopies.length} npx skills copies.`,
        fix: { type: "npx-remove", names: npxCopies.map((s) => s.name) },
      });
    if (loose.length && (plugins.length || npxCopies.length))
      fixes.push({
        label: `Archive the loose copies`,
        description: `Move ${loose.map((s) => s.name).join(", ")} to the archive and keep the ${plugin ? "plugin" : "npx"} version.`,
        fix: { type: "archive", paths: loose.map((s) => s.path) },
      });
    return {
      id: `dup:${pair}`,
      severity: identical ? "problem" : "warning",
      title: `${rows.length} skill${rows.length > 1 ? "s" : ""} installed ${Math.max(...rows.map(([, l]) => l.length)) > 2 ? "more than once" : "twice"}: ${labels
        .map((l) => (l === "Local" ? "your local copy" : l))
        .join(" and ")}`,
      detail: identical
        ? `${identical === rows.length ? "All are" : `${identical} are`} identical copies, so Claude lists the same skill twice and pays for it twice.`
        : "Same name, different content. Claude lists both and may pick either one.",
      copies: rows.map(([, list]) => list.map(copyOf)),
      fixes,
    };
  });
}

function upstream(statuses: npx.UpdateStatus[], skills: Skill[]): Finding[] {
  const pluginNames = new Map(skills.filter((s) => s.plugin).map((s) => [baseName(s), s.plugin!]));
  const gone = statuses.filter((u) => u.status === "removed");
  const replaced = gone.filter((u) => pluginNames.has(u.name));
  const orphaned = gone.filter((u) => !pluginNames.has(u.name));
  const findings: Finding[] = [];
  if (replaced.length)
    findings.push({
      id: "replaced",
      severity: "warning",
      title: `${replaced.length} old npx installs a plugin now provides`,
      detail: "These were removed from their repo but a plugin you have ships a skill with the same name. Safe to uninstall the old copies.",
      items: replaced.map((u) => `${u.name} (${u.source} → ${pluginNames.get(u.name)})`),
      fixes: [{ label: "Uninstall old copies", description: "Removes them for every agent and drops them from the npx lock.", fix: { type: "npx-forget", names: replaced.map((u) => u.name) }, recommended: true }],
    });
  const orphanInClaude = orphaned.filter((u) => u.inClaude);
  if (orphanInClaude.length)
    findings.push({
      id: "orphaned",
      severity: "warning",
      title: `${orphanInClaude.length} skills no longer exist upstream`,
      detail: "Their repo renamed or dropped them. Your copies still work but will never get updates.",
      items: orphanInClaude.map((u) => `${u.name} (was ${u.source}/${u.path})`),
      fixes: [
        { label: "Archive them", description: "Out of every session, restorable from Archive.", fix: { type: "archive", paths: orphanInClaude.map((u) => join(homedir(), ".claude/skills", u.name, "SKILL.md")) } },
        { label: "Uninstall everywhere", description: "Deletes them for every agent and drops them from the npx lock.", fix: { type: "npx-forget", names: orphanInClaude.map((u) => u.name) } },
      ],
    });
  const otherAgents = statuses.filter((u) => !u.inClaude && !replaced.includes(u));
  if (otherAgents.length)
    findings.push({
      id: "other-agents",
      severity: "info",
      title: `${otherAgents.length} npx installs other agents have but Claude Code doesn't`,
      detail: "They live in ~/.agents/skills (Codex, Pi, Warp…), which Claude Code doesn't read. Add the ones you want from the Agents tab, or all of them here.",
      items: otherAgents.map((u) => `${u.name} (${u.source}${u.status === "removed" ? ", gone upstream" : ""})`),
      fixes: [
        {
          label: "Add all to Claude Code",
          description: "Reinstalls each from its repo for Claude Code (skills gone upstream are copied from the shared folder instead).",
          fix: { type: "add-to-claude", names: otherAgents.map((u) => u.name) },
        },
        { label: "Uninstall from all agents", description: `Deletes the ${otherAgents.length} shared copies and their lock entries for every agent. This can't be undone.`, fix: { type: "npx-forget", names: otherAgents.map((u) => u.name) } },
      ],
    });
  const pending = statuses.filter((u) => u.inClaude && (u.status === "update" || u.status === "moved"));
  if (pending.length)
    findings.push({ id: "updates", severity: "info", title: `${pending.length} updates available`, detail: "Apply them from the Sources tab.", items: pending.map((u) => `${u.name} (${u.source})`), fixes: [] });
  return findings;
}

async function unused(skills: Skill[]): Promise<Finding[]> {
  const used = await usage();
  const never = skills.filter((s) => !s.plugin && s.listingTokens > 0 && !used[s.name]);
  if (!never.length) return [];
  const tokens = never.reduce((t, s) => t + s.listingTokens, 0);
  return [
    {
      id: "unused",
      severity: "info",
      title: `${never.length} skills you've never used cost ~${tokens} tokens every session`,
      detail: "Based on every transcript in ~/.claude/projects. Turn them off for a lighter session, or archive the ones you don't want.",
      items: never.map((s) => s.name),
      fixes: [{ label: "Turn them off", description: "Only changes the launch command, nothing on disk.", fix: { type: "turn-off", keys: never.map((s) => s.name) } }],
    },
  ];
}

/** Things in ~/.claude/skills that Claude silently ignores. */
function strays(): Finding[] {
  const dir = join(homedir(), ".claude/skills");
  const stray = readdirSync(dir).filter((d) => {
    if (d.startsWith(".")) return false;
    const p = join(dir, d);
    if (lstatSync(p).isSymbolicLink() && !existsSync(p)) return true; // broken link
    return !(statSync(p).isDirectory() && existsSync(join(p, "SKILL.md")));
  });
  if (!stray.length) return [];
  return [
    {
      id: "strays",
      severity: "info",
      title: `${stray.length} entries in ~/.claude/skills aren't skills`,
      detail: "No SKILL.md (or a broken link), so Claude ignores them. Usually leftovers: zips, workspaces, sync folders.",
      items: stray,
      fixes: [],
    },
  ];
}

/** Plugins that are just a GitHub repo of skills: offer to manage them with npx skills instead (per-skill picks, latest from the repo). */
function switchable(skills: Skill[], project?: string): Finding[] {
  return pluginRepos(project).flatMap(({ id, repo }) => {
    const names = skills.filter((s) => s.plugin === id && !s.path.includes("/commands/")).map(baseName);
    if (!names.length) return [];
    return [
      {
        id: `switch:${id}`,
        severity: "info" as const,
        title: `${id} could be managed with npx skills`,
        detail: `This plugin installs ${names.length} skills from ${repo} as one block. With npx skills you pick them one by one in Sources and update each from the repo. The plugin gets disabled, not deleted, so /plugin can turn it back on.`,
        items: names,
        fixes: [
          {
            label: "Switch to npx skills",
            description: `Install the ${names.length} skills from ${repo} with npx skills (Claude Code only), then disable ${id}.`,
            fix: { type: "switch-to-npx" as const, plugin: id, source: repo, names },
          },
        ],
      },
    ];
  });
}

/** Enabled plugins that contribute nothing at all — usually packaged wrong upstream (atomic-agents ships its plugin in a subfolder). */
function emptyPlugins(project?: string): Finding[] {
  const empty = listPlugins(project).filter((p) => (p.enabled || p.projectEnabled) && !p.id.endsWith("@skills-dir") && Object.values(p.components).every((n) => !n));
  if (!empty.length) return [];
  return [
    {
      id: "empty-plugins",
      severity: "warning",
      title: `${empty.length} enabled plugin${empty.length > 1 ? "s load" : " loads"} nothing`,
      detail: "No skills, commands, agents, hooks, MCP or LSP servers — Claude Code's own inventory agrees. Usually a packaging mistake upstream. Disabling is free and reversible.",
      items: empty.map((p) => p.id),
      fixes: [{ label: "Disable them", description: `Disable ${empty.map((p) => p.id).join(", ")} (they stay installed).`, fix: { type: "plugin-disable", ids: empty.map((p) => p.id) }, recommended: true }],
    },
  ];
}

export async function diagnose(project?: string): Promise<Finding[]> {
  const skills = scan(project);
  const statuses = await npx.checkUpdates();
  const order = { problem: 0, warning: 1, info: 2 };
  return [...duplicates(skills), ...upstream(statuses, skills), ...switchable(skills, project), ...emptyPlugins(project), ...(await unused(skills)), ...strays()].sort(
    (a, b) => order[a.severity] - order[b.severity],
  );
}

const PLUGIN_ID = /^[\w.-]+@[\w.-]+$/;

export async function applyFix(fix: Fix, p?: Progress) {
  switch (fix.type) {
    case "npx-remove":
      return npx.remove(fix.names);
    case "npx-forget":
      return npx.remove(fix.names, true);
    case "plugin-disable":
      for (const id of fix.ids) await pluginAction(id, "disable", p);
      return;
    case "add-to-claude":
      return { results: await addToClaude(fix.names, p) };
    case "archive":
      return fix.paths.forEach(archive); // archive() refuses anything that isn't a .claude/skills/<x>/SKILL.md
    case "switch-to-npx": {
      if (!PLUGIN_ID.test(fix.plugin)) throw new Error("Bad plugin id");
      // only names the repo actually publishes, or `skills add` fails the whole batch
      p?.setTotal(3);
      p?.step(`Reading ${fix.source}`);
      const available = new Set((await npx.repoSkills(fix.source)).map((s) => s.name));
      const names = fix.names.filter((n) => available.has(n));
      const missing = fix.names.filter((n) => !available.has(n));
      p?.step(`Installing ${names.length} skills with npx skills`);
      if (names.length) await npx.add(fix.source, { skills: names });
      p?.step(`Disabling ${fix.plugin}`);
      const res = Bun.spawnSync(["claude", "plugin", "disable", fix.plugin, "--json"]);
      // already disabled (e.g. the fix was queued twice) is the state we want
      if (!res.success && !/already disabled/i.test(res.stderr.toString() + res.stdout.toString())) throw new Error(`Installed via npx, but disabling ${fix.plugin} failed: ${res.stderr.toString().trim()}`);
      return { installed: names.length, notInRepo: missing };
    }
    default:
      throw new Error("This fix runs in the browser");
  }
}

if (import.meta.main) {
  for (const f of await diagnose()) console.log(`[${f.severity}] ${f.title}\n  fixes: ${f.fixes.map((x) => x.label).join(" | ") || "-"}`);
  console.assert(basename("/a/b/SKILL.md") === "SKILL.md");
}
