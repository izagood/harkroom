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
| **Agent machines (operator)** | macOS (ships inside the desktop app). Linux headless runs from a source build — no packaged Linux build yet (systemd / launchd templates included) |
| **Server** | Docker image for `linux/amd64` and `linux/arm64`, with PostgreSQL |
| **Agent CLIs (harnesses)** | [Claude Code](https://github.com/anthropics/claude-code) (`claude`), [Codex](https://github.com/openai/codex) (`codex`), [opencode](https://opencode.ai) (`opencode`) |
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
  and talks to the server on their behalf. The desktop app starts it for you **while the app is
  running**. To keep agents answering after a restart without opening the app, turn on
  **Settings › This machine's operator › Start at login** (macOS 13+) — the app then starts without a
  window when you log in. A machine without the app runs the operator on its own.
- **Runner** — one per agent. It waits for a mention and runs that turn. Both the runner and the
  operator ship inside the desktop app
  (`/Applications/Harkroom.app/Contents/MacOS/harkroom-runner`, next to `harkroom-operator`).
- **Harness** — the AI CLI that does the work. It reads the thread and replies with Harkroom's
  tools, which go back through the operator.
- **Database** keeps the hub's data. **AVCS** is optional and runs separately.

## Getting started

Harkroom is self-hosted: **you run the server yourself**, then everyone connects to it with the
desktop app. The path below goes from nothing to a first conversation with an agent.

**You need**

- A machine with **Docker** and **Docker Compose v2.24.4+** for the server. Any Linux box, VM or your own Mac works.
- A **Mac with Apple silicon** for the desktop app.
- On the machine that will run agents (usually the same Mac): **Node.js 22+** and at least one
  harness CLI — [Claude Code](https://github.com/anthropics/claude-code) (`claude`),
  [Codex](https://github.com/openai/codex) (`codex`) or [opencode](https://opencode.ai)
  (`opencode`) — installed, on your `PATH`, and already logged in. **Install Node before you open
  the app**: the operator is a Node program, and without Node it cannot start. Homebrew
  (`brew install node`), the [nodejs.org](https://nodejs.org/en/download) installer, nvm, volta,
  fnm, asdf and mise all work — an app opened from the Dock does not get your terminal's `PATH`,
  so it reads your login shell's `PATH`, then `~/.zshrc`, then those tools' usual folders.

### 1. Run your server

```sh
git clone https://github.com/izagood/harkroom && cd harkroom
```

**On a public machine (a VPS or any host reachable from the internet), keep port 3400 private
from the very first start.** The default compose file publishes it on every interface. Bind it
to localhost with an override file next to `docker-compose.yml`:

```yaml
# compose.override.yaml — picked up automatically by `docker compose`
services:
  server:
    ports: !override
      - "127.0.0.1:3400:3400"
```

If you would rather use a firewall, use your cloud or provider firewall — host firewalls such as
`ufw` or `firewalld` do not filter ports that Docker publishes.

Then start it:

```sh
docker compose pull                  # fetch the latest published server image
docker compose up -d                 # PostgreSQL + that server image, on port 3400
curl http://localhost:3400/readyz    # {"ok":true} once the server can reach its database
```

The server is the published image `ghcr.io/izagood/harkroom-server`; you don't need to build
anything. `docker compose up` alone does not refresh an image you already have, so run `pull`
first whenever you want the newest one. Migrations run on startup. To pin a release instead of `latest`, see
[Server image](#server-image).

**Create the admin account right away (step 2), before the server is reachable from anywhere
else.** On a remote host you can do that from your Mac through an SSH tunnel
(`ssh -L 3400:localhost:3400 <your-host>`) and use `http://localhost:3400` as the server URL.

**Reaching it from other machines.** Port 3400 speaks plain HTTP, so never expose it directly.
Run a reverse proxy that terminates **HTTPS** (Caddy, nginx, Traefik, …) on the same host and
forwards to `localhost:3400`, including WebSocket upgrades. Then set
[`TRUST_PROXY`](#configuration) to your proxy's IP or CIDR (not `true`) so rate limits see real
client addresses. Using it only on the machine
that runs the server, `http://localhost:3400` is enough.

### 2. Install the app and create the admin account

1. Download the latest `.dmg` from [Releases](https://github.com/izagood/harkroom/releases) and
   open the app. It updates itself from then on.
2. Enter your **Server URL** (for example `http://localhost:3400` or `https://chat.example.com`).
3. Choose **First run? Create the admin account** and fill in a login ID (2–32 characters), a
   handle (`@name`, 2–32 lowercase letters, digits, `-` and `_`), a display name and a password
   (8 characters or more).

This works only once, while the server has no person yet; it makes you the owner and creates a
`#general` channel. Ignore **Create a hosted community** on that screen — it is for a hosted
service, not for a server you run yourself.

<details>
<summary>Create the admin account from the command line instead</summary>

Put the password in a file rather than on the command line (command lines are visible in `ps`
and your shell history):

```sh
umask 077
cat > bootstrap.json <<'JSON'
{"loginId":"me","handle":"me","displayName":"Me","password":"change-this-password"}
JSON
curl -X POST http://localhost:3400/bootstrap \
  -H 'content-type: application/json' \
  --data @bootstrap.json
rm -f bootstrap.json
```

Then sign in from the app with that login ID and password.

</details>

### 3. Let this Mac run agents

Agents run on an **operator** — a background process the app starts for you. As the owner of a
new community, your first Mac is **registered automatically** when you sign in. Otherwise (a
teammate's Mac, or your second Mac) register it once under
**Settings › This device › This machine's operator › Register this machine**.

Then open **Settings › Agents › Operators**: this Mac's row lists the harness CLIs it found, as
*installed* and *logged in*. If yours is missing, install it, make sure `claude --version` (or
`codex` / `opencode`) works in a new terminal, and check again. If the operator could not start
or register, the app says why in a strip at the top of the window and on the
*This machine's operator* page.

### 4. Create your first agent

Open **Agents** and choose **New agent**. Give it a handle, pick its harness and model, and
leave **Run it on this machine** on so it starts right away on the operator from step 3.

### 5. Talk to it

In `#general` (or any channel you create with **Create channel**), write
`@your-agent say hello`. The agent replies in a thread; open its terminal from the thread to
watch it work. If it needs a decision it posts a question card for you to answer.

### 6. Invite your team

Under **Settings › Community › Members & invites**, choose **Mint an invite token** and send it
to a teammate. They install the app, enter your server URL and choose
**Have an invite token? Join this community**. Each token works once.

### Run agents on another machine (optional)

An always-on box can run agents too. Install Node.js 22+ and a harness CLI there, and get the
operator: on a Mac, install the desktop app (the operator is
`/Applications/Harkroom.app/Contents/MacOS/harkroom-operator`). There is no packaged Linux build
yet — build it from a checkout of this repository with `pnpm install` and
`node packages/desktop/scripts/build-sidecars.mjs` (it lands in
`packages/desktop/src-tauri/binaries/`). Then under **Settings › Agents › Operators** mint a registration code and, within five minutes,
run on that machine:

```sh
harkroom-operator register https://<your-server> <code>
harkroom-operator run      # keep it running; see ops/operator.service.template (systemd)
                           # or ops/operator.plist.template (launchd)
```

Assign agents to it from the agent's **Where it runs** setting.

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
| `TRUST_PROXY` | Which reverse proxies to trust for `X-Forwarded-For`: a hop count of 2 or more, or comma-separated proxy IPs/CIDRs (use this for a single proxy). `1`/`true` trusts every hop and lets clients spoof their address — not recommended | `false` | No |
| `HARKROOM_RETENTION_DELETE` | `1` turns on the retention sweep's deletes: `idempotency_key` rows older than 7 days and `session` rows expired for more than 30 days, at most 1,000 rows per table per hour. Anything else (unset, `0`, `true`) keeps it in dry-run: the sweep only logs `retention: <table> eligible=N (dry-run)` every hour and deletes nothing. See `docs/operations.md` §13 | unset (dry-run) | No |
| `HARKROOM_BACKGROUND_ENABLED` | `1` turns on background agent turns (memory distillation/cleanup that run without a chat thread and post nothing to chat): the server's job sweep runs and runners may claim jobs, only between 03:00 and 07:00 KST, at most one per agent, kind and day. Anything else keeps them off | unset (off) | No |
| `HARKROOM_BACKGROUND_DAILY_MAX` | Upper bound on background jobs created per day across the whole server (non-negative integer) | `50` | No |
| `HARKROOM_SECRET_KEY` | Key used to encrypt automation webhook secrets at rest (AES-256-GCM). Required only to turn on **GitHub** webhook receiving for an automation — the server must read the secret back to verify `X-Hub-Signature-256`. Any string; keep it stable, since changing it makes existing GitHub keys unverifiable (reissue them) | - | No |
| `HARKROOM_SECRET_KEYS_DIR` | Directory holding the keys for the **secret store** (secrets that people hand to agents). One file per key, file name = key id, content = exactly 32 random bytes as base64 (44 chars) or hex (64 chars) — e.g. `openssl rand -base64 32`. Mount it from a Kubernetes Secret as a volume rather than passing keys as env. Unset = the secret store is off. If set but a key is malformed, the server refuses to start. **There is no copy of the key anywhere else — back it up yourself; if you lose it, the stored secrets cannot be recovered and have to be entered again.** The server remembers a check value per key id, so if a different key shows up under an id it already knows, that id is disabled (and the secret store turns off if it is the active one) instead of mixing two keys. To change a key, add it under a **new** file name (key id) and point `HARKROOM_SECRET_KEY_ID` at it | - | No |
| `HARKROOM_SECRET_KEY_ID` | Which key in `HARKROOM_SECRET_KEYS_DIR` seals new secret values. Optional when the directory holds a single key; required when it holds more than one (key rotation) | - | No |
| `ATTACHMENT_ROOT` | File system path for uploaded attachments | `./.attachments` (the published image sets `/var/lib/harkroom/attachments`) | No |
| `ATTACHMENT_MAX_BYTES` | Maximum attachment size in bytes | `26214400` (25MB) | No |
| `CLAIM_TOKEN_HASH` | sha256 hex digest of a one-time workspace claim token. When set, the server seeds it into `claim_token` at startup and `POST /claim` will create the first admin for whoever presents the matching token. Only for hosted deployments that provision empty instances — self-hosting uses `/bootstrap` instead. Pass the **digest**, never the token itself | - | No |
| `HARKROOM_SMTP_HOST` | SMTP server that sends invite emails. Set it together with `HARKROOM_MAIL_FROM` and `HARKROOM_PUBLIC_URL` to let admins invite people by email; leave all mail variables unset to keep mail off (invites are then handed over as a token on screen, as before). Setting only some of the required ones stops the server at startup | - | No |
| `HARKROOM_SMTP_PORT` | SMTP port. `465` uses TLS from the start; any other port must offer STARTTLS (plain-text SMTP is refused) | `587` | No |
| `HARKROOM_SMTP_USER` | SMTP user name. Set it together with `HARKROOM_SMTP_PASSWORD`, or neither | - | No |
| `HARKROOM_SMTP_PASSWORD` | SMTP password or API key. Mount it from a Kubernetes Secret; never commit it | - | No |
| `HARKROOM_MAIL_FROM` | Sender of invite emails, e.g. `Harkroom <invite@your-domain.example.com>`. The domain needs SPF/DKIM records from your mail provider or mail lands in spam | - | No |
| `HARKROOM_PUBLIC_URL` | The address people use to reach this server, e.g. `https://workspace.example.com`. Invite emails show it as the server address and link to `<this>/join`. Must be `https` (`http` only for `localhost`). Read only when mail is configured — set alone, it does not turn mail on or stop startup | - | No |
| `APNS_KEY_ID` | Key ID of the Apple Push Notifications (APNs) auth key (`.p8`). Set all four `APNS_*` variables to turn on mobile push; leave all unset to keep it off. Setting only some of them stops the server at startup | - | No |
| `APNS_TEAM_ID` | Apple Developer Team ID that owns the APNs key | - | No |
| `APNS_KEY_P8` | Contents of the APNs auth key file (`AuthKey_<KeyID>.p8`, PEM). Mount it from a Kubernetes Secret; never commit it | - | No |
| `APNS_TOPIC` | Bundle ID of the mobile app that receives the pushes | - | No |
| `HARKROOM_NEW_PASSWORD` | New password read by `packages/server/scripts/reset-password.ts`; only set for that one command | - | No |
| `HARKROOM_COMMIT` | Commit sha stamped at image build time; served by `GET /healthz` so operators can tell which build is running. Pass it as a Docker build arg (`HARKROOM_COMMIT=$(git rev-parse --short HEAD) docker compose build server`). Reported as `null` when unset | - | No |
| `HARKROOM_MANDATE_ENFORCE` | `on` makes the server decide agent merges by the turn's mandate lines (a matching merge line, including standing lines from the owner's merge grants) instead of the cause chain; no matching line refuses with `no_mandate_line` and a permission card. One-time merge approvals work as before. Any other value keeps today's decision (the mandate verdict is only logged) | `off` | No |
| `HARKROOM_DELEGATION_FOLLOWUP` | `1` lets a later `message.report` from someone who already answered a delegation wake the agent that handed it over (within 6 hours, at most 3 times). Default off: turn it on only after every app is on a release that knows this inbox reason. |
| `HARKROOM_DELEGATION_V2` | Reserved for the delegation redesign: `1` will keep a delegation open after the first `message.report` and pass the delegate's later posts to the agent that handed it over. Nothing reads it yet; leave it off until every runner knows the `delegation_update` inbox reason | `off` | No |
| `HARKROOM_DELEGATION_IMPLICIT` | Read only while `HARKROOM_DELEGATION_V2` is on. How an agent calling another agent with a leading mention is treated as a delegation: `shadow` records the verdict in `delegation_implicit_log` and changes nothing else (no delegation row, no wake, no update); `on` also opens a `kind=mention` delegation; `off` does nothing | `shadow` | No |
| `HARKROOM_PRINCIPAL_INVOKE` | Agent mention calls also pass when the person who woke the turn (its principal) could call that agent directly; at most 200 such agent posts per principal per 24 hours. `off` (or `0`/`false`) goes back to recording what would have opened (`mentionPrincipalShadow`) without opening it | `on` | No |
| `HARKROOM_VERSION` | Overrides the release number `GET /healthz` reports. Normally unset — the server reads `packages/desktop/src-tauri/tauri.conf.json`, which is this repo's version source of truth. Set it only when building outside this repo's layout | from `tauri.conf.json` | No |

The desktop app has no environment variables; it asks for the server URL on first launch.

<details>
<summary>Operator and runner environment (advanced)</summary>

The operator normally gets its paths from the desktop app. Run headless, it reads:

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `HARKROOM_DATA_DIR` | Data directory shared with the desktop app (socket, `operator/operator.json`, tokens, per-agent MCP config) | `~/Library/Application Support/app.harkroom.desktop` (macOS), `$XDG_DATA_HOME/app.harkroom.desktop` (Linux), `%APPDATA%\app.harkroom.desktop` (Windows) | No |
| `HARKROOM_OPERATOR_PER_COMMUNITY` | `1` turns on one operator per community (isolation plan C): each community gets its own root `~/.harkroom-agent/c/<8-char hash of the server URL>/` listed in `operators.json` under the data directory. Anything else keeps today's single operator | unset (off) | No |
| `HARKROOM_OPERATOR_ROOT` | With the per-community switch on: this operator's community root. Account choice (`claude-pools.json`, `codex-active.json`) lives here; logged-in account directories stay shared on the machine | set by the launcher | Only when the switch is on |
| `HARKROOM_OPERATOR_LEGACY` | With the per-community switch on: `1` when this community reuses the old single-operator location, so agent state and workspaces stay under `~/.harkroom-agent`. Otherwise they live under `<community root>/agents` | set by the launcher | Only when the switch is on |
| `HARKROOM_OPERATOR_COMMUNITY` | With the per-community switch on: the server URL this operator process serves. `operator.json` refuses any other community | set by the launcher | Only when the switch is on |
| `HARKROOM_OPERATOR_VERSION` | Version stamped into the pid record and passed to runners as `AGENT_VERSION` when started headless | - | No |
| `HARKROOM_MAX_TURNS` | Maximum number of turns running at once across **all** runners of this operator. When full, new mentions stay unread in the inbox and start once a turn finishes. `0` or unset means no limit. Background agent turns (`HARKROOM_BACKGROUND_ENABLED`) always leave one slot free for mention turns, so with `1` they never run. Read by the operator at startup | - (no limit) | No |
| `XDG_DATA_HOME` / `APPDATA` | Read only to compute the default data directory | platform default | No |
| `CLAUDE_CONFIG_DIR` | Where the operator looks for `.claude.json` when resolving an agent's `mcpServers` by name (after `<data dir>/operator/mcp-servers.json`) | `~` | No |

The operator sets the runner's environment itself when it starts a runner; you normally never
set these by hand:

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `HARKROOM_OPERATOR_SOCKET` | Unix socket of the operator that spawned this runner. Everything the runner says to the server (PTY relay, MCP, REST) goes through it — the runner has no server URL and no token | - | Yes |
| `HARKROOM_RUNNER_ID` | Runner id the operator assigned at spawn; the server multiplexes this runner's frames by it | - | Yes |
| `HARKROOM_COMMAND_HOOK` | `1` when `operator.json` has `commandHook: true`. The runner then attaches a PreToolUse hook (`harkroom-operator hook pretool`, inline `--settings`) to auto-mode Claude Code mention turns, so a Bash command the owner approved **exactly** (kind `command`, once or for an hour) runs without the permission classifier. Anything else stays with the classifier. Off by default | unset (off) | No |
| `HARKROOM_CHROME_HOST` | Set by the operator on every runner spawn: `1` only when the operator was launched by the desktop app (`--launch-nonce`) and the Claude in Chrome native messaging host manifest exists in a Chromium-family browser directory, otherwise `0`. Claude Code turns get `--chrome` only when this is `1` **and** the agent's `chromeEnabled` is on and the agent is not read-only; every other Claude Code turn gets `--no-chrome` | `0` (off) | No |
| `HARKROOM_RUNNER_SECRET` | One-time secret for the operator link; set by the operator at spawn | - | Yes |
| `HARKROOM_OPERATOR_BIN` | Path of `harkroom-operator`; codex gets it as the `mcp-bridge` command via `-c mcp_servers.harkroom.*` | - | Yes |
| `HARKROOM_MCP_CONFIG` | Harness MCP config file the operator wrote before spawn (harkroom bridge + avcs + the agent's `mcpServers` resolved from `<appDataDir>/operator/mcp-servers.json` or `~/.claude.json`). The runner never writes it | - | Yes |
| `HARKROOM_POST_TOOL_HOOK` | `0` when `operator.json` has `postToolHook: false`; the operator always sets `0` or `1`. When on, the runner attaches a PostToolUse hook (`harkroom-operator hook posttool`, inline `--settings`) to auto-mode Claude Code mention turns: after each tool call it loads human posts that arrived in the turn's own thread since the turn started, so a "stop" written mid-turn reaches the running turn. It never makes a permission decision; on any failure it prints nothing | `1` (on) | No |
| `HARKROOM_HANDOVER_HOLD` | Inbox entry ids the *previous* generation runner still has turns running on, set by the operator when it starts a replacement before that runner has exited. This runner skips them until the operator says the old runner is gone (`handover.released`), so the same mention is never answered twice. New mentions that arrive in a thread the old runner is still working on are held back by the server-side thread claim instead (`POST /agent/thread-claims`: one runner per agent and thread, renewed while the turn runs, taken over after it expires) | - | No |
| `HARKROOM_HANDOVER_DONE` | Inbox entry ids whose turns the *previous* generation runner already finished but could not mark read (its server link was down when it retired). This runner marks them read without starting a turn, so a finished request is never answered a second time | - | No |
| `AGENT_POLL_TIMEOUT_MS` | Inbox polling timeout | `25000` (25s) | No |
| `AGENT_INBOX_LEASE` | `0` turns off the inbox lease: the runner stops telling `inbox.poll` which entries it is working on, so the server hands them back on every poll (the old path) | unset (on) | No |
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
| `HARKROOM_TURN_SECRETS_DIR` | Where the operator writes secrets mounted for a turn (`<appDataDir>/turn-secrets`). The operator sets it at spawn; the runner reads mounted values from it to scrub them out of the harness transcript before releasing the turn lease. Unset (older operator) means no scrubbing | - | No |
| `OPENCODE_CONFIG` | Set **by the runner** on opencode turns, not read from your shell: the per-turn opencode config file in the runner state folder (0600). API key connection turns carry the lane provider settings in it, and turns with a turn credential carry the harkroom MCP entry. A value in the runner's own environment is not used for those turns | - | No |
| `OPENCODE_TEST_HOME` | Set **by the runner** on API key connection (provider lane) opencode turns, not read from your shell: points opencode's home lookups at an empty per-agent folder (`<opencode home>/lane-home`) so instructions, skills, config and plugins from your home are not loaded. The shell's `HOME` is unchanged. A value in the runner's own environment is dropped for those turns | - | No |
| `CLAUDE_CONFIG_DIR` | Not read by the runner — **set on the child** `claude` process to the selected account's directory. Credentials and session files both follow it, so switching it switches accounts. Omitted entirely when the pool is empty, leaving the child on the system default `~/.claude` | - | No |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` | Source opencode home whose `opencode/auth.json` and provider settings are linked into the runner-isolated opencode home under `AGENT_STATE_DIR`; child `opencode` processes always get the isolated triple (opencode splits config, credentials and state across all three, so isolating one alone leaves the other two shared) | `~/.config`, `~/.local/share`, `~/.local/state` | No |
| `PI_CODING_AGENT_DIR` | Source pi home whose `auth.json` and `models.json` are linked into the runner-isolated pi home (`pi-home` under `AGENT_STATE_DIR`), along with only `defaultProvider`/`defaultModel` from its `settings.json`; child `pi` processes always get the isolated home. `PI_CODING_AGENT_SESSION_DIR` is removed from the child so sessions stay inside it. For `omp` turns the child also gets a runner-isolated `HOME` (`omp-home` under `AGENT_STATE_DIR`) and `OMP_PROFILE` is removed, since a profile selects another directory inside the home | `~/.pi/agent` | No |

</details>

## Troubleshooting

- **`/bootstrap` answers `already_bootstrapped`.** The server already has a person; sign in, or
  ask the owner for an invite token.
- **The app cannot reach the server.** Check `curl <your server URL>/readyz` from the same Mac.
  Behind a proxy, make sure it forwards WebSocket upgrades.
- **An agent never answers.** Check that its operator is online under
  **Settings › Agents › Operators** and lists the agent's harness as installed. The machine needs
  `node` (22+) and the harness CLI on its `PATH`. On a Mac the app does not see your terminal's
  `PATH`: it reads the login shell's (`~/.zprofile`), then `~/.zshrc`, then the usual Node folders
  — a `node` that only works after something your terminal runs by hand will not be found.
- **"Node.js is too old".** The operator found a `node` older than 22. Install 22 or newer, or put
  the newer one first on your `PATH`, then reopen the app.
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
```

`apps/` holds one thing today, and that is on purpose rather than by accident. The split is by
role — `apps/` is what a person or a machine runs, `packages/` is what those things import — and
the rest of the move is deferred until the open pull requests land. The mobile client went
straight to its final home because it is new: there was no history to move, and placing it
correctly now is cheaper than moving it twice.

Two consequences worth knowing:

- **pnpm does not see `apps/`.** `pnpm -r test` and `pnpm -r typecheck` skip it, which is
  intended — that directory belongs to pub. Run its checks from `apps/mobile` with `flutter`.
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
