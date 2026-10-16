import index from "./index.html";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { repos, scan, verify } from "./server/scan";
import { usage } from "./server/usage";
import { archive, listArchive, remove, restore } from "./server/archive";
import * as npx from "./server/npx";
import * as satl from "./server/satl";
import { applyFix, diagnose } from "./server/doctor";
import { addToClaude, agentMatrix, copySkills } from "./server/agents";
import { clearFinished, enqueue, listJobs, type Progress } from "./server/jobs";
import { listPlugins, pluginAction } from "./server/plugins";
import { locations, removeEverywhere } from "./server/locations";
import { readSkillFile, remoteSkillFile, writeSkillFile } from "./server/files";
import { hooks, mcpServers } from "./server/integrations";
import { detect, writeConfig } from "./server/config";

const projectDir = (raw?: string | null) => {
  const project = raw?.trim() ? resolve(raw.trim().replace(/^~/, homedir())) : undefined;
  if (project && !(existsSync(project) && statSync(project).isDirectory())) throw new Error(`Not a directory: ${project}`);
  return project;
};

// JSON-only forces a CORS preflight, so random websites can't hit these mutating endpoints on localhost
const post = (fn: (body: any) => unknown) => ({
  POST: async (req: Request) => {
    if (req.headers.get("content-type") !== "application/json") return new Response("JSON only", { status: 415 });
    try {
      return Response.json((await fn(await req.json())) ?? { ok: true });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  },
});

// long-running changes go through the serial job queue; the response is the queued job, progress comes from /api/jobs
const job = (label: (body: any) => string, total: number, fn: (body: any, p: Progress) => Promise<unknown>) =>
  post((body) => ({ job: enqueue(label(body), total, (p) => fn(body, p)) }));

const FIX_LABEL: Record<string, (f: any) => string> = {
  "npx-remove": (f) => `Remove ${f.names.length} npx copies`,
  "npx-forget": (f) => `Uninstall ${f.names.length} skills everywhere`,
  "switch-to-npx": (f) => `Switch ${f.plugin} to npx skills`,
  "add-to-claude": (f) => `Add ${f.names.length} skills to Claude Code`,
  "plugin-disable": (f) => `Disable ${f.ids.join(", ")}`,
  archive: (f) => `Archive ${f.paths.length} skills`,
};

// DNS rebinding: a website whose domain resolves to 127.0.0.1 would otherwise count as same-origin
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
type Handler = (req: Request) => Response | Promise<Response>;
const guard = (routes: Record<string, unknown>) => {
  const wrap = (h: Handler): Handler => (req) => (LOCAL_HOST.test(req.headers.get("host") ?? "") ? h(req) : new Response("Forbidden", { status: 403 }));
  return Object.fromEntries(
    Object.entries(routes).map(([path, r]) => [
      path,
      typeof r === "function" ? wrap(r as Handler) : r && typeof r === "object" && !("index" in r) && Object.values(r).every((v) => typeof v === "function") ? Object.fromEntries(Object.entries(r).map(([m, h]) => [m, wrap(h as Handler)])) : r,
    ]),
  ) as any;
};

const routes: Record<string, Handler | Partial<Record<"GET" | "POST", Handler>> | typeof index> = {
    "/*": index,
    "/api/repos": () => Response.json(repos()),
    "/api/config": { GET: () => Response.json(detect()), ...post((patch) => (writeConfig(patch), detect())) },
    "/api/verify": async (req) => {
      try {
        return Response.json(await verify(projectDir(new URL(req.url).searchParams.get("project"))));
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 500 });
      }
    },
    "/api/skills": (req) => {
      try {
        const project = projectDir(new URL(req.url).searchParams.get("project"));
        return Response.json({ project, skills: scan(project) });
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
      }
    },
    // proxied server-side: skills.sh sends no CORS headers
    "/api/search": async (req) => {
      const q = new URL(req.url).searchParams.get("q") ?? "";
      const res = await fetch(`https://skills.sh/api/search?q=${encodeURIComponent(q)}&limit=50`);
      if (!res.ok) return Response.json({ skills: [], error: (await res.json()).error }, { status: res.status });
      const { skills } = await res.json();
      return Response.json({ skills: skills.toSorted((a: any, b: any) => b.installs - a.installs) });
    },
    "/api/install": job(
      ({ source, skills }) => (skills?.length ? `Install ${skills.length} from ${source}` : `Install ${source}`),
      1,
      async ({ source, project, skills }, p) => (p.step("Running npx skills add"), { results: skills?.length ? await npx.addPicked(String(source ?? ""), skills, projectDir(project)) : await npx.add(String(source ?? ""), { project: projectDir(project) }) }),
    ),
    "/api/updates": async (req) => {
      const q = new URL(req.url).searchParams;
      return Response.json(await npx.checkUpdates({ source: q.get("source") ?? undefined, fresh: q.has("fresh") }));
    },
    // reinstall from the locked folder, or from where it moved upstream
    "/api/update": job(({ name }) => `Update ${name}`, 1, async ({ name, movedTo }, p) => (p.step(`Updating ${name}`), npx.update(name, movedTo))),
    "/api/update-many": job(
      ({ items }) => `Update ${items.length} skills`,
      0,
      async ({ items }: { items: { name: string; movedTo?: string }[] }, p) => {
        p.setTotal(items.length);
        const failed: string[] = [];
        for (const { name, movedTo } of items) {
          p.step(`Updating ${name}`);
          await npx.update(name, movedTo).catch((e) => (failed.push(name), p.log(`${name}: ${e.message}`)));
        }
        if (failed.length) throw new Error(`Couldn't update ${failed.join(", ")}`);
      },
    ),
    // forget = remove for every agent and drop the lock entry (only offered for skills gone upstream)
    "/api/uninstall": job(({ names }) => `Remove ${names.length} skills`, 1, async ({ names, forget }, p) => (p.step("Running npx skills remove"), npx.remove(names, !!forget))),
    "/api/sources": async () => Response.json(await npx.sources()),
    "/api/sources/pin": post(({ repo }) => npx.pinSource(repo)),
    "/api/sources/hide": post(({ repo }) => npx.hideSource(repo)),
    // uninstall = every Claude Code copy from that repo goes to the archive (restorable), then the source is hidden
    "/api/sources/remove": job(
      ({ repo }) => `Remove source ${repo}`,
      0,
      async ({ repo }, p) => {
        const names = npx.skillsFrom(repo);
        p.setTotal(names.length + 1);
        for (const name of names) {
          p.step(`Removing ${name}`);
          const claudeCopy = locations(name).locations.filter((l) => l.where === "Claude Code").map((l) => l.path);
          if (claudeCopy.length) removeEverywhere(name, claudeCopy);
        }
        p.step("Hiding the source");
        npx.hideSource(repo);
      },
    ),
    "/api/source": async (req) => {
      const repo = new URL(req.url).searchParams.get("repo") ?? "";
      if (!npx.SOURCE.test(repo) || repo.includes("@")) return Response.json({ error: "Expected owner/repo" }, { status: 400 });
      try {
        return Response.json(await npx.repoSkills(repo));
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 502 });
      }
    },
    "/api/satl/catalog": () => Response.json(satl.catalog()),
    "/api/satl/status": async (req) => {
      const q = new URL(req.url).searchParams;
      try {
        return Response.json(await satl.status(projectDir(q.get("project"))!, q.has("fetch")));
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
      }
    },
    "/api/satl/install": post(async ({ project, include, exclude, dryRun }) => ({ log: await satl.install(projectDir(project)!, include, exclude, dryRun) })),
    "/api/satl/sync": job(() => "Pull SATL and sync", 1, async ({ project }, p) => (p.step("git pull + satl sync"), { log: await satl.sync(projectDir(project)!) })),
    "/api/doctor": async (req) => {
      try {
        return Response.json(await diagnose(projectDir(new URL(req.url).searchParams.get("project"))));
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 500 });
      }
    },
    "/api/doctor/fix": job(({ fix }) => FIX_LABEL[fix?.type]?.(fix) ?? "Fix", 1, async ({ fix }, p) => (p.step("Working"), applyFix(fix, p))),
    "/api/agents": () => Response.json(agentMatrix()),
    "/api/agents/copy": post(({ from, to, names }) => copySkills(from, to, names)),
    "/api/agents/add-to-claude": job(({ names }) => `Add ${names.length} skills to Claude Code`, 0, async ({ names }, p) => ({ results: await addToClaude(names, p) })),
    "/api/jobs": { GET: () => Response.json(listJobs()), ...post(({ id }) => clearFinished(typeof id === "number" ? id : undefined)) },
    "/api/plugins": (req) => {
      try {
        return Response.json(listPlugins(projectDir(new URL(req.url).searchParams.get("project"))));
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 500 });
      }
    },
    "/api/plugins/action": job(
      ({ id, action }) => `${String(action).replace(/^./, (c) => c.toUpperCase())} ${id}`,
      1,
      async ({ id, action }, p) => pluginAction(id, action, p),
    ),
    "/api/locations": (req) => {
      const q = new URL(req.url).searchParams;
      try {
        return Response.json(locations(q.get("name") ?? "", projectDir(q.get("project"))));
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
      }
    },
    "/api/remove-everywhere": job(
      ({ name, paths }) => (paths?.length === 1 ? `Archive ${name}` : `Archive ${name} from ${paths?.length ?? 0} places`),
      1,
      async ({ name, paths, project }, p) => removeEverywhere(String(name), paths ?? [], projectDir(project), p),
    ),
    "/api/skill-file": {
      GET: async (req) => {
        const q = new URL(req.url).searchParams;
        try {
          if (q.get("repo")) return Response.json(await remoteSkillFile(q.get("repo")!, q.get("folder") ?? ""));
          return Response.json(readSkillFile(q.get("path") ?? "", projectDir(q.get("project"))));
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
      },
      ...post(({ path, content, project }) => writeSkillFile(path, content, projectDir(project))),
    },
    // same as /api/satl/install but queued, so the Library's apply bar never blocks
    "/api/satl/apply": job(
      ({ include, exclude }) => `SATL: ${[...(include ?? []).map((t: string) => `+${t}`), ...(exclude ?? []).map((t: string) => `−${t}`)].join(" ") || "reinstall"}`,
      1,
      async ({ project, include, exclude }, p) => (p.step("satl install"), { log: await satl.install(projectDir(project)!, include ?? [], exclude ?? []) }),
    ),
    "/api/mcp": (req) => Response.json(mcpServers(projectDir(new URL(req.url).searchParams.get("project")))),
    "/api/hooks": (req) => Response.json(hooks(projectDir(new URL(req.url).searchParams.get("project")))),
    "/api/usage": async () => Response.json(await usage()),
    "/api/archive": { GET: () => Response.json(listArchive()), ...post(({ path }) => archive(path)) },
    "/api/restore": post(({ name }) => restore(name)),
    "/api/delete": post(({ archived, path }) => remove({ archived, skillMd: path })),
};

// 4555 keeps the browser's saved picks (localStorage is per port); when it's taken, any free port will do
const serve = (port: number) =>
  Bun.serve({
    port,
    hostname: "127.0.0.1", // /api/install runs commands: never expose it on the network
    development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
    routes: guard(routes),
  });
let server: ReturnType<typeof serve>;
try {
  server = serve(Number(process.env.PORT ?? 4555));
} catch {
  server = serve(0);
}

console.log(`Skill manager → ${server.url}`);
