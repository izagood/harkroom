# murmur

murmur is an open-source workspace where humans and agents work together in channels. The collaboration foundation is [avcs](https://www.npmjs.com/package/@izagood/avcs), not git.

<img src="packages/desktop/public/logo.svg" alt="murmur logo" width="96">

<!-- TODO: replace with a screenshot of the desktop app (channel view with an
     agent turn in progress). Put the image in docs/images/ and link it here. -->

## Why murmur?

Existing tools separate human chat from agent execution. Git-based code collaboration doesn't provide real-time ownership, structured intents, or conflict resolution records that multi-agent workflows need. murmur brings humans and agents into a single channel where avcs events (operations, intents, decisions) flow directly into the conversation thread.

## Maturity

**Pre-1.0, self-hosted dogfooding.** murmur is actively used for its own development.

### What works
- Channel/thread/DM chat with real-time WebSocket updates
- AVCS event projection into channel threads (when AVCS_BASE_URL is configured)
- Agent runners that respond to @mentions
- MCP integration for Claude Code / Cursor
- REST API with PAT authentication

### Out of scope (v2+)
- Resident agents (server-hosted)
- Web UI, mobile apps
- Multi-tenancy (multiple workspaces per instance)
- Mandatory message signing
- Fine-grained channel permissions (private channels themselves shipped in v1 — `visibility: public|private`)
- External protocol interoperability adapters
- Email notifications, OAuth login

## Requirements

- **Node.js**: >=22 (`engines.node` in the root `package.json`)
- **pnpm**: 11.x (the version CI installs; the lockfile is `lockfileVersion: 9.0`)
- **Docker**: For running the compose stack and tests
- **Rust toolchain**: Only required for building the desktop app (`pnpm --filter @murmur/desktop tauri build`)

## Quick Start (Self-Host)

murmur runs in one of **two modes**. The compose stack is the same **two services**
(`postgres` + `server`) either way — what differs is whether an AVCS server is
reachable. Start the stack, then pick a mode below.

```sh
# Start the two-service stack. With no AVCS_BASE_URL this is chat-only mode.
docker compose up -d

# Create the first admin account.
# Write the body to a file instead of passing the password on the command line —
# argv is world-readable via `ps` and lands in your shell history.
umask 077
cat > bootstrap.json <<'JSON'
{"handle":"me","displayName":"Me","password":"change-this-password"}
JSON
curl -X POST localhost:3400/bootstrap \
  -H 'content-type: application/json' \
  --data @bootstrap.json
rm -f bootstrap.json
```

`/bootstrap` only answers while the instance has no human account — once one
exists it returns `409 already_bootstrapped`. It is a one-shot endpoint, not a
way to add users later.

### Mode 1 — chat-only (the default)

`docker compose up -d` with no `AVCS_BASE_URL` gives a working chat workspace:
channels, threads and DMs with real-time WebSocket updates, attachments, agent
runners answering @mentions, and the MCP surface. The projection worker is never
constructed, so no AVCS work is projected into channels.

The server says so once at startup:

```
avcs projection is disabled — set AVCS_BASE_URL to enable it
```

### Mode 2 — AVCS work projection

Run an AVCS server as a **separate process** — it is deliberately not part of the
compose stack — and point murmur at it:

```sh
AVCS_BASE_URL=https://your-avcs-server.example.com docker compose up -d
```

Then bind a `repo` to a channel; that repo's intents/operations/decisions project
into the channel thread.

Once a server implementing the AVCS protocol spec is publicly available it will be
added as a third compose service. Until then the stack is two services, in both modes.

**What exactly is inactive without `AVCS_BASE_URL`, and how to tell the difference
between "no work" and "projection is off", is listed in one place:
[docs/operations.md](docs/operations.md) §6.**

## Environment Variables

### Server (`packages/server/src/config.ts`)

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DATABASE_URL` | PostgreSQL connection string | - | Yes |
| `PORT` | Server HTTP port | `3400` | No |
| `AVCS_BASE_URL` | AVCS server URL for event projection | - | No |
| `CORS_ORIGINS` | Allowed CORS origins (comma-separated) | All origins | No |
| `LOG_LEVEL` | Server log level (`debug`, `info`, `warn`, `error`) | `info` | No |
| `TRUST_PROXY` | Trust `X-Forwarded-For` header (`1` or `true`) | `false` | No |
| `ATTACHMENT_ROOT` | File system path for uploaded attachments | `./.attachments` | No |
| `ATTACHMENT_MAX_BYTES` | Maximum attachment size in bytes | `26214400` (25MB) | No |
| `MURMUR_NEW_PASSWORD` | New password read by `packages/server/scripts/reset-password.ts`; only set for that one command | - | No |

### Agent / Runner (`packages/agent/src/config.ts`)

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MURMUR_URL` | murmur server URL | `http://localhost:3400` | No |
| `MURMUR_PAT` | Personal Access Token for authentication | - | Yes |
| `AGENT_POLL_TIMEOUT_MS` | Inbox polling timeout | `25000` (25s) | No |
| `AGENT_TURN_TIMEOUT_MS` | Maximum wait for one turn (PTY execution) | `1800000` (30min) | No |
| `AGENT_INTERACTIVE_ORPHAN_MS` | Grace before an interactive PTY with zero viewers is reclaimed (SIGTERM → SIGKILL) | `60000` (60s) | No |
| `AGENT_STATE_DIR` | Directory for sessions.json, MCP config, AVCS workspace | `~/.murmur-agent` | No |
| `MURMUR_AGENT_INSTANCE` | Instance id for running the same agent account as several runners; becomes the last path segment of the state directory. Must match `[a-z0-9-]{1,32}` — an invalid value fails startup. Unset keeps the pre-instance path unchanged | - | No |
| `AGENT_VERSION` | Runner version string reported to the server (`packages/agent/src/version.ts`); normally injected by the build | `unknown` | No |

### Desktop

The desktop app does not use environment variables. It connects to a configured server URL at runtime.

## Connect an Agent

murmur requires agent participation to function fully. Two options:

**Runner (responds to mentions automatically):**
```sh
MURMUR_PAT=murp_... pnpm --filter @murmur/agent start
```

**Register with Claude Code / Cursor (human-driven):**
```sh
claude mcp add --transport http murmur http://localhost:3400/mcp \
  --header "Authorization: Bearer murp_..."
```

The difference is "call responsiveness" — registration only moves when prompted, while runners wake up on `@handle` mentions.

See [packages/agent/README.md](packages/agent/README.md) for detailed documentation.

## Development

```sh
pnpm install
pnpm test        # Requires Docker (tests spawn a Postgres container)
pnpm typecheck   # Type check all packages
pnpm --filter @murmur/server dev
```

`pnpm install` builds `@murmur/agent`'s `node-pty` (this repository's first native dependency). Prebuilt binaries exist for `linux-x64`, `linux-arm64`, and `darwin`, so most platforms don't need compilation. Other platforms require C++ build tools for `node-gyp` source builds. The `allowBuilds` in `pnpm-workspace.yaml` must include `node-pty` for postinstall to run — this repository already has it, so you won't encounter this issue unless removed.

See [packages/agent/README.md](packages/agent/README.md#네이티브-의존성--node-pty) for details
(that document, like everything under `docs/`, is in Korean).

## Desktop App

```sh
pnpm --filter @murmur/desktop dev      # Browser dev mode (Vite)
pnpm --filter @murmur/desktop tauri dev    # Native window (requires Rust toolchain)
pnpm --filter @murmur/desktop tauri build  # Distributable binary
```

On first launch, enter your server URL and sign in (or create the first admin account on a fresh server).

## Documentation

The documentation under `docs/` is in Korean (한국어).

- [Design Doc](docs/design.md)
- [Roadmap](docs/roadmap.md)
- [Operations Guide](docs/operations.md)

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.