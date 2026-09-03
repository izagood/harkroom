# murmur

murmur is an open-source workspace where humans and agents work together in channels. The collaboration foundation is [avcs](https://www.npmjs.com/package/@izagood/avcs), not git.

![logo](packages/desktop/public/logo.svg)

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
- Private channels, fine-grained channel permissions
- External protocol interoperability adapters
- Email notifications, OAuth login

## Requirements

- **Node.js**: >=22
- **pnpm**: >=9
- **Docker**: For running the full stack and tests
- **Rust toolchain**: Only required for building the desktop app (`pnpm --filter @murmur/desktop tauri build`)

## Quick Start (Self-Host)

```sh
# Start the full stack
docker compose up -d

# Create the first admin account
curl -X POST localhost:3400/bootstrap \
  -H 'content-type: application/json' \
  -d '{"handle":"me","displayName":"Me","password":"changeme1"}'
```

To connect an AVCS server, set `AVCS_BASE_URL`. When you bind a `repo` to a channel, that repo's intents/operations/decisions project into the channel thread.

If `AVCS_BASE_URL` is not set, the projection worker is disabled and only chat functions. The AVCS server is not included in the compose stack — run it as a separate process and point to it with `AVCS_BASE_URL`. Once a server implementing the AVCS protocol spec is publicly available, it will be added as a third compose service.

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

### Agent / Runner (`packages/agent/src/config.ts`)

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MURMUR_URL` | murmur server URL | `http://localhost:3400` | No |
| `MURMUR_PAT` | Personal Access Token for authentication | - | Yes |
| `AGENT_POLL_TIMEOUT_MS` | Inbox polling timeout | `25000` (25s) | No |
| `AGENT_TURN_TIMEOUT_MS` | Maximum wait for one turn (PTY execution) | `1800000` (30min) | No |
| `AGENT_STATE_DIR` | Directory for sessions.json, MCP config, AVCS workspace | `~/.murmur-agent` | No |

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

See [packages/agent/README.md](packages/agent/README.md#native-dependencies--node-pty) for details.

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