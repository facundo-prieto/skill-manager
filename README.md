# Skill manager

A local web app for the Claude Code skills on your machine.

- See every skill a session loads, where it came from (your own, `npx skills`, a plugin, SATL) and how many tokens it costs.
- Pick which skills the next session gets. The app builds a `claude --settings …` command for you; nothing is uninstalled.
- Install, update and remove skills from GitHub repos through [`npx skills`](https://github.com/vercel-labs/skills), and search [skills.sh](https://skills.sh).
- Find duplicates, skills gone from their repo, and skills only other agents (Codex, Cursor…) have.
- Enable, disable and inspect plugins. Browse the MCP servers and hooks every agent is configured with.
- Archive your own skills instead of deleting them, and restore them later.
- Optional: manage SATL team and people skills per repo.

It runs only on your machine, on `127.0.0.1`. The only outside calls are to GitHub (checking skill repos for updates) and skills.sh (when you search).

## Run it

You need [Bun](https://bun.sh) 1.3 or later and [Claude Code](https://docs.claude.com/en/docs/claude-code) installed.

```bash
git clone <this repo>
cd skill-manager
bun install
bun run dev
```

Open http://127.0.0.1:4555. If that port is taken, the terminal prints the one it used. Keep the terminal open while you use the app; Ctrl+C stops it.

`bun run dev` reloads as you edit the code. `bun run start` runs it without the dev tooling.

## What it uses

| Tool | Needed for |
| --- | --- |
| Claude Code (`claude`) | Required. Lists plugins and checks what a session loads. |
| Node.js (`npx`) | Installing and updating skills from GitHub. |
| `git` | Checking a SATL clone for new commits. |
| `abc` | Optional. If its config exists, its repo list fills the repo picker. |
| `satl` and a SATL knowledge-base clone | Optional. Turns on the SATL section. |

Open **Settings** in the sidebar to see what was found. Anything missing can be set by hand there: the abc config file, the SATL clone, and any repos you want in the picker. You can also type a repo path straight into the repo picker.

## What it changes on disk

- Removing one of your own skills moves it to `~/.claude/skills-archive`. Restore it, or delete it for good, from **Archive**.
- GitHub skills are installed and removed with `npx skills`, for Claude Code only (`~/.claude/skills`, or the repo's `.claude/skills`).
- Plugin switches run `claude plugin enable/disable/uninstall`.
- SATL changes run `satl install` in the repo you picked, which updates that repo's `.satl/config.json`.
- Picking skills for the next session only changes what's saved in your browser.
- The app's own settings live in `~/.config/skill-manager/`.

Changes go through a queue (the **Activity** button), one at a time.

## Security

The server listens on `127.0.0.1` only. It rejects requests whose `Host` isn't localhost, and every request that changes something must be JSON, so a web page you visit can't drive it. MCP and hook views never show environment values or headers, and mask anything that looks like a token.

## Code

- `src/index.ts`: the Bun server and its API routes.
- `src/server/`: one module per area (scanning, `npx skills`, SATL, plugins, doctor, archive, agents, integrations, settings).
- `src/views/`, `src/components/`: the React UI, built with shadcn/ui and Tailwind.

`bun run typecheck` checks types. Some server modules have a small self-check you can run directly, for example `bun src/server/satl.ts`.
