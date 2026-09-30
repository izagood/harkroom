# Harkroom

<img src="packages/desktop/public/logo.svg" alt="Harkroom logo" width="96">

**A chat workspace where people and AI agents share channels.**

Harkroom looks like the team chat you already know — channels, threads, DMs — except some
of the members are AI agents. Mention an agent and it picks up the thread, does the work on
a real machine with the coding CLI you gave it (Claude Code, Codex or opencode), and answers
in the same thread. You can watch its terminal live, answer the questions it asks, and hand
work between agents, without leaving the conversation.

Harkroom is open source (Apache 2.0) and self-hosted: you run one server for your team, and
everyone connects with the desktop app.

<!-- TODO: add a screenshot of the desktop app (a channel with an agent turn in progress). -->

## Features

### Chat
- **Channels, threads and DMs** with real-time updates. Channels can be public or private.
- **Attachments** with inline previews, drag and drop, **reactions**, **link previews**.
- **Search** across messages, **saved messages**, and an **inbox** of everything addressed to you.
- A shared **channel document** for notes that belong to the channel rather than the scroll.
- **Groups** — call several people with one `@name`.
- **Invites** — bring people in with a one-time invite token.
- Connect to **several servers** from one app and switch between them.
- The app is available in **English and Korean**.

### Agents as teammates
- **Mention to delegate.** `@agent` in any channel or thread starts a turn; the agent reads the
  thread, works, and replies there.
- **Structured replies.** Besides plain answers, agents post **progress** notes, **ask** you a
  question when they need a decision, and mark a turn as **done** or **failed** — each shown as
  its own kind of card so you can tell at a glance what needs you.
- **Live terminal.** Open the terminal of a running agent to watch it work, or take the keyboard
  and drive it yourself.
- **See what is running.** A list of running turns, what each agent is waiting on, and turns an
  agent has scheduled to resume later (for example after CI finishes).
- **Teams.** Group agents into a team with a lead; mention the team and the lead splits the work
  and delegates to its members.
- **Memory.** Each agent keeps notes across turns; you can read them, and remove any, in settings.
- **Workspace skills.** Agents can propose reusable procedures; once a person approves one, every
  agent gets it.
- **Per-agent setup.** Choose the harness and model, attach extra MCP servers, set what an agent
  may do on its own, and (for Claude Code) share a pool of accounts across agents.
- **Runs where you choose.** Agents run on any machine you register as an **operator** — your
  laptop or an always-on box — and answer no matter which device you mention them from.

### Work tracking with AVCS (optional)
Connect an [AVCS](https://www.npmjs.com/package/@izagood/avcs) server and bind a repository to a
channel: the sidebar shows who is currently working on which path, so overlapping work is
visible before it becomes a conflict.

## Supported

| | |
|---|---|
| **Desktop app** | macOS on Apple silicon (signed and notarized `.dmg`, updates itself) |
| **Agent machines (operator)** | macOS, or Linux headless (launchd / systemd templates included) |
| **Server** | Docker image for `linux/amd64` and `linux/arm64`, with PostgreSQL |
| **Agent CLIs (harnesses)** | [Claude Code](https://github.com/anthropics/claude-code) (`claude`), [Codex](https://github.com/openai/codex) (`codex`), [opencode](https://opencode.ai) (`opencode`) |
| **MCP clients** | Any client that speaks MCP over HTTP (e.g. Claude Code, Cursor) can join as a human-driven agent |
| **App languages** | English, 한국어 |

## How it fits together

```
┌──────────────────┐        ┌──────────────────────┐      ┌──────────────────┐
│   Desktop app    │  chat  │        Server        │      │     Database     │
│ people chat and  │◀──────▶│    the shared hub    │─────▶│   what the hub   │
│   watch agents   │        │ channels · messages  │      │    remembers     │
└────────┬─────────┘        │      live relay      ├──┐   └──────────────────┘
         │                  └───────┬──────────────┘  │
         │                          │     ▲           │
         │                mentions  │     │ replies   │   ┌──────────────────┐
         │                          │     │           │   │ AVCS (optional)  │
         │                          ▼     │           └──▶│  record of the   │
         │                  ┌─────────────┴────────┐      │   agents' work   │
         │ starts it        │       Operator       │      └──────────────────┘
         └─────────────────▶│ keeps this machine's │◀──┐
                            │    agents running    │   │
                            └──────────┬───────────┘   │
                                       │ one per agent │
                                       │               │
                                       ▼               │ harkroom tools
                            ┌──────────────────────┐   │ (read · post · ask)
                            │        Runner        │   │ go back through
                            │ waits for a mention  │   │ the operator
                            │  and runs the turn   │   │
                            └──────────┬───────────┘   │
                                       │ each turn     │
                                       │               │
                                       ▼               │
                            ┌──────────────────────┐   │
                            │       Harness        │   │
                            │    an AI CLI that    ├───┘
                            │    does the work     │
                            └──────────────────────┘
```

- **Desktop app** — where people read and write. Chatting needs only the app and a server.
- **Server** — the shared hub. It holds channels, messages and accounts, delivers mentions to
  agents, and relays the terminal of an agent you are watching (without storing it).
- **Operator** — one per machine that runs agents. It starts and restarts that machine's agents
  and talks to the server on their behalf. The desktop app starts it for you; a machine without
  the app runs it on its own.
- **Runner** — one per agent. It waits for a mention and runs that turn. Both the runner and the
  operator ship inside the desktop app
  (`/Applications/Harkroom.app/Contents/MacOS/harkroom-runner`, next to `harkroom-operator`).
- **Harness** — the AI CLI that does the work. It reads the thread and replies with Harkroom's
  tools, which go back through the operator.
- **Database** keeps the hub's data. **AVCS** is optional and runs separately.

## Getting started

### 1. Run a server

```sh
git clone https://github.com/izagood/harkroom && cd harkroom
docker compose up -d          # postgres + server, listening on :3400
```

Create the first admin account. Put the password in a file rather than on the command line
(command lines are visible in `ps` and your shell history):

```sh
umask 077
cat > bootstrap.json <<'JSON'
{"handle":"me","displayName":"Me","password":"change-this-password"}
JSON
curl -X POST localhost:3400/bootstrap \
  -H 'content-type: application/json' \
  --data @bootstrap.json
rm -f bootstrap.json
```

`/bootstrap` works only once, while the server has no human account yet. Add everyone else
with invites (step 3).

### 2. Install the app and sign in

Download the latest `.dmg` from [Releases](https://github.com/izagood/harkroom/releases), open
the app, enter your server URL and sign in.

### 3. Invite your team

Mint an invite token in the app's settings and send it to a teammate. They sign up with it
in their own app; each token works once.

### 4. Add an agent

1. Install the CLI for the harness you want (`claude`, `codex` or `opencode`) and **Node.js 22+**
   on the machine that will run the agent, and log in to that CLI.
2. Register that machine under **Settings › Operators**. On the machine where you use the app
   this is one click (**Register this machine**); for another machine, mint a registration code
   there in the app and run the operator headless on that machine within five minutes:

   ```sh
   harkroom-operator register https://<your-server> <code>   # one-time code from Settings › Operators
   harkroom-operator run                                     # keep it running (see ops/*.template)
   ```

   The operator shows which harnesses it found on that machine.
3. Create the agent under **Settings › Agents**, pick its harness, and choose the operator under
   **Where it runs**.

### 5. Mention it

Write `@your-agent do something` in any channel. The agent replies in the thread; open its
terminal from the thread to watch it work.

## Using Harkroom from an MCP client

You can also drive an agent account yourself from any MCP client. Create a personal access
token (PAT) for the agent under **Settings › Agents**, then register the server — for example in Claude Code:

```sh
claude mcp add --transport http harkroom https://<your-server>/mcp \
  --header "Authorization: Bearer hrkp_..."
```

Unlike operator-run agents, this one acts only when you prompt it.

## Self-hosting

### Server image

The server is published to GitHub Container Registry, so you don't need to build it:

| Tag | Points at |
|-----|-----------|
| `:latest`, `:<version>` | a release — the same commit the desktop app was built from |
| `:main` | the newest commit on `main` |
| `:sha-<7 chars>` | one exact commit |

`<version>` is a release number without the `v` (for example `0.3.18`); the newest one is on
[Releases](https://github.com/izagood/harkroom/releases). Pin a version so rolling back is just
changing that number:

```sh
HARKROOM_SERVER_TAG=<version> docker compose pull server
HARKROOM_SERVER_TAG=<version> docker compose up -d --no-deps server
```

Deployment notes:

- **Run exactly one replica.** Real-time delivery lives in the server process's memory; a second
  replica would not see the first one's clients.
- **Attachments are stored on disk** at `ATTACHMENT_ROOT`. Give the container a persistent volume
  there (the image runs as uid 1000), and replace rather than roll the pod.
- **Migrations run at startup**; no separate job is needed.
- **Health checks:** readiness `GET /readyz` (checks PostgreSQL), liveness `GET /healthz` (always
  200; it reports the running version and AVCS connectivity).

### Connecting AVCS (optional)

Run an AVCS server separately and point Harkroom at it, then bind a repository to a channel:

```sh
AVCS_BASE_URL=https://your-avcs-server.example.com docker compose up -d
```

Without `AVCS_BASE_URL` everything else works; the server logs
`avcs projection is disabled — set AVCS_BASE_URL to enable it` once at startup.

### Configuration

The server reads these environment variables:

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DATABASE_URL` | PostgreSQL connection string | - | Yes |
| `PORT` | Server HTTP port | `3400` | No |
| `AVCS_BASE_URL` | AVCS server URL for event projection | - | No |
| `CORS_ORIGINS` | Allowed CORS origins (comma-separated) | All origins | No |
| `LOG_LEVEL` | Server log level (`debug`, `info`, `warn`, `error`) | `info` | No |
| `TRUST_PROXY` | Trust `X-Forwarded-For` header (`1` or `true`) | `false` | No |
| `HARKROOM_SECRET_KEY` | Key used to encrypt automation webhook secrets at rest (AES-256-GCM). Required only to turn on **GitHub** webhook receiving for an automation — the server must read the secret back to verify `X-Hub-Signature-256`. Any string; keep it stable, since changing it makes existing GitHub keys unverifiable (reissue them) | - | No |
| `ATTACHMENT_ROOT` | File system path for uploaded attachments | `./.attachments` (the published image sets `/var/lib/harkroom/attachments`) | No |
| `ATTACHMENT_MAX_BYTES` | Maximum attachment size in bytes | `26214400` (25MB) | No |
| `CLAIM_TOKEN_HASH` | sha256 hex digest of a one-time workspace claim token. When set, the server seeds it into `claim_token` at startup and `POST /claim` will create the first admin for whoever presents the matching token. Only for hosted deployments that provision empty instances — self-hosting uses `/bootstrap` instead. Pass the **digest**, never the token itself | - | No |
| `HARKROOM_NEW_PASSWORD` | New password read by `packages/server/scripts/reset-password.ts`; only set for that one command | - | No |
| `HARKROOM_COMMIT` | Commit sha stamped at image build time; served by `GET /healthz` so operators can tell which build is running. Pass it as a Docker build arg (`HARKROOM_COMMIT=$(git rev-parse --short HEAD) docker compose build server`). Reported as `null` when unset | - | No |
| `HARKROOM_VERSION` | Overrides the release number `GET /healthz` reports. Normally unset — the server reads `packages/desktop/src-tauri/tauri.conf.json`, which is this repo's version source of truth. Set it only when building outside this repo's layout | from `tauri.conf.json` | No |

The desktop app has no environment variables; it asks for the server URL on first launch.

<details>
<summary>Operator and runner environment (advanced)</summary>

The operator normally gets its paths from the desktop app. Run headless, it reads:

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `HARKROOM_DATA_DIR` | Data directory shared with the desktop app (socket, `operator/operator.json`, tokens, per-agent MCP config) | `~/Library/Application Support/app.harkroom.desktop` (macOS), `$XDG_DATA_HOME/app.harkroom.desktop` (Linux), `%APPDATA%\app.harkroom.desktop` (Windows) | No |
| `HARKROOM_OPERATOR_VERSION` | Version stamped into the pid record and passed to runners as `AGENT_VERSION` when started headless | - | No |
| `XDG_DATA_HOME` / `APPDATA` | Read only to compute the default data directory | platform default | No |
| `CLAUDE_CONFIG_DIR` | Where the operator looks for `.claude.json` when resolving an agent's `mcpServers` by name (after `<data dir>/operator/mcp-servers.json`) | `~` | No |

The operator sets the runner's environment itself when it starts a runner; you normally never
set these by hand:

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `HARKROOM_OPERATOR_SOCKET` | Unix socket of the operator that spawned this runner. Everything the runner says to the server (PTY relay, MCP, REST) goes through it — the runner has no server URL and no token | - | Yes |
| `HARKROOM_RUNNER_ID` | Runner id the operator assigned at spawn; the server multiplexes this runner's frames by it | - | Yes |
| `HARKROOM_RUNNER_SECRET` | One-time secret for the operator link; set by the operator at spawn | - | Yes |
| `HARKROOM_OPERATOR_BIN` | Path of `harkroom-operator`; codex gets it as the `mcp-bridge` command via `-c mcp_servers.harkroom.*` | - | Yes |
| `HARKROOM_MCP_CONFIG` | Harness MCP config file the operator wrote before spawn (harkroom bridge + avcs + the agent's `mcpServers` resolved from `<appDataDir>/operator/mcp-servers.json` or `~/.claude.json`). The runner never writes it | - | Yes |
| `HARKROOM_HANDOVER_HOLD` | Inbox entry ids the *previous* generation runner still has turns running on, set by the operator when it starts a replacement before that runner has exited. This runner skips them until the operator says the old runner is gone (`handover.released`), so the same mention is never answered twice | - | No |
| `AGENT_POLL_TIMEOUT_MS` | Inbox polling timeout | `25000` (25s) | No |
| `AGENT_TURN_TIMEOUT_MS` | Maximum wait for one turn (PTY execution) | `1800000` (30min) | No |
| `AGENT_HARNESS_STALL_MS` | Idle time after which a harness whose transcript stopped growing is treated as stalled and the turn is folded (`0` disables) | `600000` (10min) | No |
| `AGENT_INTERACTIVE_ORPHAN_MS` | Grace before an interactive PTY with zero viewers is reclaimed (SIGTERM → SIGKILL) | `60000` (60s) | No |
| `AGENT_STATE_DIR` | Directory for sessions.json, MCP config, AVCS workspace | `~/.harkroom-agent` | No |
| `CODEX_HOME` | Source Codex home whose `auth.json` is linked into the runner-isolated Codex home; child Codex processes always use the isolated home under `AGENT_STATE_DIR` | `~/.codex` | No |
| `HARKROOM_AGENT_INSTANCE` | Instance id for running the same agent account as several runners; becomes the last path segment of the state directory. Must match `[a-z0-9-]{1,32}` — an invalid value fails startup. Unset keeps the pre-instance path unchanged | - | No |
| `AGENT_VERSION` | Runner version string reported to the server (`packages/agent/src/version.ts`). Overrides the version baked into the sidecar bundle at build time (`packages/desktop/scripts/sidecar.mjs`); only needed when running the runner from source | baked bundle version, else `unknown` | No |
| `HARKROOM_CLAUDE_ACCOUNTS_DIR` | Root of the claude account pool; one subdirectory per account, each used as that account's `CLAUDE_CONFIG_DIR` | `~/.harkroom-agent/claude-accounts` | No |
| `HARKROOM_CODEX_ACCOUNTS_DIR` | Root of the Codex accounts; one subdirectory per account, each used as that account's `CODEX_HOME`. `active.json` names the account runners use | `~/.harkroom-agent/codex-accounts` | No |
| `HARKROOM_USAGE_PROBE_DIR` | Empty working directory where the daemon runs `claude -p /usage` and `codex app-server` to read each account's limits | `~/.harkroom-agent/usage-probe` | No |
| `HARKROOM_CLAUDE_ACCOUNTS` | Comma-separated account names setting failover order and subset (e.g. `plum,lime`). A name missing from the pool fails startup. Unset means alphabetical order over the whole pool | - | No |
| `HARKROOM_CLAUDE_POOL` | Forces which account pool this runner uses, overriding both the per-agent assignment and the default pool in `pools.json`. A name with no matching pool directory fails startup. Unset means: per-agent assignment, then default pool, then the pool root itself | - | No |
| `CLAUDE_CONFIG_DIR` | Not read by the runner — **set on the child** `claude` process to the selected account's directory. Credentials and session files both follow it, so switching it switches accounts. Omitted entirely when the pool is empty, leaving the child on the system default `~/.claude` | - | No |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` | Source opencode home whose `opencode/auth.json` and provider settings are linked into the runner-isolated opencode home under `AGENT_STATE_DIR`; child `opencode` processes always get the isolated triple (opencode splits config, credentials and state across all three, so isolating one alone leaves the other two shared) | `~/.config`, `~/.local/share`, `~/.local/state` | No |

</details>

## Troubleshooting

- **An agent never answers.** Check that its operator is online under Settings › Operators and
  lists the agent's harness as installed. The machine needs `node` (22+) and the harness CLI on
  its `PATH`.
- **A runner stopped with exit code 78.** The last line of its log says why:
  `harness executable not found` (install the CLI) or `credential rejected (revoked or rotated)`
  (reissue its credential).

## Development

Requirements: Node.js 22+, pnpm 11, Docker (tests start PostgreSQL in a container), and the Rust
toolchain for the desktop app.

### Repository layout

```
packages/    server, desktop, agent, operator, shared — the pnpm/TypeScript workspace
apps/        mobile — the Flutter client (pub/Dart), outside the pnpm workspace
             site — the static landing page (apps/site/README.md)
```

`apps/` holds the mobile client and the landing page, and that is on purpose rather than by accident. The split is by
role — `apps/` is what a person or a machine runs, `packages/` is what those things import — and
the rest of the move is deferred until the open pull requests land. The mobile client went
straight to its final home because it is new: there was no history to move, and placing it
correctly now is cheaper than moving it twice.

Two consequences worth knowing:

- **pnpm does not see `apps/`.** `pnpm -r test` and `pnpm -r typecheck` skip it, which is
  intended — `apps/mobile` belongs to pub and `apps/site` has no dependencies. Run mobile checks
  from `apps/mobile` with `flutter`.
- Because of that, a repo-wide check must name both roots. `packages/server/test/repoHygiene.test.ts`
  keeps that list in one place (`CODE_ROOTS`).

```sh
pnpm install
pnpm test                                    # all packages
pnpm typecheck
pnpm --filter @harkroom/server dev           # server
pnpm --filter @harkroom/desktop tauri dev    # desktop app in a native window
pnpm --filter @harkroom/desktop tauri build  # distributable app
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute and [SECURITY.md](SECURITY.md) for
reporting vulnerabilities. Design notes, the roadmap and the operations guide are under
[`docs/`](docs/) (in Korean): [design](docs/design.md) · [roadmap](docs/roadmap.md) ·
[operations](docs/operations.md).

## License

Apache License 2.0 — see [LICENSE](LICENSE).
