# Sessions Desk

A local dashboard for people who run many [Claude Code](https://claude.com/claude-code) sessions at once on a
Windows machine. It lists every open session, shows which ones are working, waiting for you or finished, lets you
read their screen and conversation, and lets you answer them — from one browser tab, or from your phone.

> **Status: shared as-is.** This is a tool one team built for its own daily use and published in the hope it is
> useful. There is no support and no compatibility promise. Issues are welcome; they may not get an answer.
>
> Sessions Desk is an independent project. It is not affiliated with, endorsed by or supported by Anthropic.

## What it does

- **One list for all sessions** — status (working, waiting for an answer, done and unread), title, folder, git
  branch, pull request, model, token count. Notifications when a session finishes or waits.
- **Read** — the live terminal screen of a session, or its full conversation rendered from the transcript.
- **Answer** — type a reply, press a key, accept the suggested prompt, queue a message while the session works,
  send the same message to several sessions.
- **Start, fork, reopen, close** — new session in a folder or in a fresh git worktree, a fork of an existing
  session, reopen a closed one, close the ones whose work is merged.
- **Find** — full-text search across conversations, favourites, hide, tags.
- **Attach files** — drag and drop, paste or pick a file; the session receives its path.
- **From your phone** — read and answer over your own Tailscale network.

Optional modules, all off by default: an external orchestrator that launches headless sessions, Microsoft Teams
reply tracking, ticket references, an account usage banner, and the passes of your own scheduled scripts. See
[Optional modules](#optional-modules).

## Requirements

- Windows 11 with [Windows Terminal](https://aka.ms/terminal). Sessions must run in Windows Terminal tabs.
- Claude Code, installed and signed in.
- [Node.js](https://nodejs.org/) 22.18 or later (the server runs TypeScript sources directly).
- [.NET 10 SDK](https://dotnet.microsoft.com/download), to build the small Windows driver once.
- Optional: `git` and the GitHub CLI `gh` (branch and pull-request state), Tailscale (phone access).

macOS and Linux are not supported: reading a session's screen and typing into it rely on the Windows console API
and on Windows Terminal.

## Install

```powershell
git clone <this repository>
cd sessions-desk/server
npm ci
npm run build:driver          # builds the Windows driver into .build/driver
node src/main.ts --port 8765  # then open http://localhost:8765/
```

The server listens on the loopback interface only. Without `--port 8765` it starts on 8767 in read-only mode,
which is handy for a first look: it lists and reads sessions but refuses every action.

Optionally, let Claude Code tell the dashboard when a turn ends, so that "done" shows up immediately. Add this to
`~/.claude/settings.json`:

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "http", "url": "http://localhost:8765/api/hook", "timeout": 2 } ] } ] } }
```

## How it works

- **Server** (`server/`, Node.js, no runtime dependency) — reads `~/.claude` (session files, transcripts,
  history), serves the page and the JSON API.
- **Driver** (`driver/`, .NET) — a resident helper the server talks to over stdin/stdout. It attaches to a
  session's console to read its screen or type into it, focuses the right Windows Terminal tab, opens tabs and
  shows notifications.
- **Page** — plain JavaScript, no framework, no build step.

Sessions Desk does not use the Claude API and never sees your credentials. It drives the same terminal sessions
you would drive by hand.

It relies on behaviour Claude Code does not document — the layout of `~/.claude`, the transcript format, what the
terminal screen looks like. A Claude Code update can break it.

## Configuration

Everything specific to a machine lives in `~/.claude/sessions-desk/config.json` (another path: `--config <file>`
or the `SD_CONFIG` environment variable). The file is optional. A template is in `server/config.example.json`.

| Key | Purpose |
|---|---|
| `ui.pathPrefix` | Folder prefix not repeated in the list (for instance your main repository) |
| `ui.prUrl`, `ui.ticketUrl`, `ui.ticketLabel` | Where pull-request and ticket links point |
| `modules` | The optional modules below |

Paths may use `~`, `%USERPROFILE%`, `%LOCALAPPDATA%` and `%TEMP%`. A missing or malformed entry is ignored: the
server never fails to start because of this file.

### Optional modules

| Module | What it turns on | Settings |
|---|---|---|
| `launcher` | A view of runs started by an external orchestrator (headless sessions), their files, alerts and orders | `root`: the orchestrator's data folder · `cli`: the command that receives orders · `ticketApi`: the command that reads a ticket · `cardsApi`: the command that lists and answers the question cards the orchestrator addresses to you (`pending`, `cards <ticket>`, `answer <ticket> <card> --answers-file <file>`, one JSON line each; it alone holds the ticket system's address and token) · `python` |
| `teams` | Sessions that wait for a Microsoft Teams reply or an Outlook email reply (opt-in `"mail": true`), with reminders; and a per-conversation view (💬) of all your active Teams chats — yours to answer, to look at, up to date — whether or not a session follows them, with full messages and an optional reply box that posts in your name on your click (opt-in `"reply": true`; the view itself is opt-in `"conversations": { "enabled": true }` in the watcher's own configuration file) | `enabled` |
| `tickets` | The "current subject" of a session, from ticket references in your prompts | `pattern`: a regular expression |
| `quota` | An account usage banner | `file`: a usage file written by a collector of your own |
| `automations` | Your scheduled scripts (cleanups, reports…): one group per script in the list, a card in the overview, the detail of a pass (summary, files, live conversation of its `claude -p` session), failure notifications and « run now » buttons | A list: `id`, `label`, `icon`, `history` (its JSONL history) · `runs` (folder of its passes) · `everyMinutes` · `cli` + `python` + `orders` (`id`, `label`, `args`, `confirm`) |

The `launcher` module is published as an example of plugging an orchestrator in; it expects that orchestrator's
own folder layout and is unlikely to fit yours unchanged.

The `automations` module reads one key per history line, written by your script:

```json
{"pass": {"v": 1, "status": "ok", "level": "ok", "summary": "3 folders cleaned · 4.2 GB freed", "startedAt": "2026-11-20T08:00:16Z",
          "minutes": 2.4, "runDir": "C:\\…\\runs\\20261120-080001", "sessionId": null, "costUsd": null,
          "files": ["report.md"], "quiet": false, "dryRun": false}}
```

`status` is `ok`, `nothing`, `dry-run`, `conflict`, `rejected` or `failed`; `level` (`ok`, `warn`, `error`) is the
health of the pass itself and drives notifications (every `error`, a second `warn` in a row); `quiet` passes get no
row, only a count in the group header; `files` are the only files of `runDir` the page may open, and `runDir` must be
under `runs`. A running `claude -p` whose command line cites a folder under `runs` is shown as the running pass.

### Tags

Tags are read from `~/.claude/state/session-tags/`. They are written by `server/src/tagger.ts`, a standalone
program meant to run as a scheduled task (`node server/src/tagger.ts`). It is published as-is: its rules
(`server/src/tagger-config.json`) and some of its code describe the original team's repository, so you will have
to adapt them to yours.

### Running it at logon

`server/watchdog/Install-NodeWatchdog.ps1 -Port 8765 -Primary` copies the current commit to a run folder and
registers a scheduled task that starts the server at logon and restarts it if it stops answering.
`server/scripts/restart-idle-sessions.ps1` is an optional helper that restarts idle sessions.
`server/watchdog/Deploy.ps1` does it all from a clean, pushed clone: it reinstalls the server and copies the tagger
and the Teams watcher to `~/.claude/scripts`, creating their scheduled tasks on first run.
When only `page/` changed since the running commit, it swaps the page files in place instead of restarting the
server: no downtime, and open pages reload themselves (`-Restart` forces a restart; decision and tests in
`server/watchdog/Deploy-Plan.ps1` and `deploy-plan-tests.ps1`).

## Keyboard shortcuts

`/` search · `n` next session that needs you · `r` reply · `p` take the suggested prompt · `h` screen /
conversation · `d` fork the selected session · `f` favourite · `x` close the session (or hide a closed one) ·
`c` copy the command that resumes it · `b` back · `t` board · `l` launcher view.

## Phone access

The server also listens on the next port (8766) for [`tailscale serve`](https://tailscale.com/kb/1312/serve):

```powershell
tailscale serve --bg http://localhost:8766
```

Use `serve`, which stays inside your own tailnet. **Never use `funnel`**, which would publish your sessions to
the internet.

## Security

Read this before you run it.

- **Single-user machines only.** There is no local authentication. Any process running on the machine can call
  the API and type into your sessions.
- **It can type into terminals.** Anything that can make the server send text to a session can run commands as
  you, within what that session is allowed to do.
- **Screens and transcripts contain secrets.** Whatever a session printed is readable through the dashboard.
- The server listens on loopback only, checks the `Origin` of every action, and serves remote requests only
  through `tailscale serve`.

Please report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Development

```powershell
cd server
npm run typecheck
npm test          # builds the driver, then runs the tests against throw-away test consoles
```

Tests never write to a real session: they open their own test consoles. Source comments, test names and the
interface are in French.

## License

[MIT](LICENSE).
