# Security Policy

## Supported Versions

Only the `main` branch is actively supported with security updates. We recommend always using the latest version from main.

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |

## Reporting a Vulnerability

We use GitHub's private vulnerability reporting system for security issues. **Do not open a public issue** for security vulnerabilities.

To report a vulnerability:

1. Go to the [Security tab](https://github.com/izagood/murmur/security) of this repository
2. Click "Report a vulnerability"
3. Fill out the vulnerability report form

murmur is a pre-1.0 project maintained by a single author, so there is no staffed on-call rotation and no guaranteed response window. Reports are acknowledged as soon as they are seen. We ask that you give us reasonable time to address the vulnerability before disclosing it publicly.

## Self-Hosting Security Considerations

If you are self-hosting murmur, please observe the following security practices:

### Personal Access Tokens (PAT)

- Treat PATs like passwords — never commit them to version control
- Rotate PATs periodically
- Use the minimum required permissions when creating PATs
- murmur has no per-token IP allowlist; restrict network access at the reverse proxy or firewall instead
- Keep secrets out of `argv`. Anything passed on a command line is visible to every local user via `ps` and is written to shell history — this is why the bootstrap example in the README posts a `0600` request body file instead of `-d '{...}'`, and why `packages/server/scripts/reset-password.ts` reads `MURMUR_NEW_PASSWORD` from the environment rather than from an argument

### Attachment Storage

- The `ATTACHMENT_ROOT` environment variable controls where uploaded files are stored. Attachments live on the server's local filesystem — object storage is not supported
- Point `ATTACHMENT_ROOT` at a directory the server user owns, outside any web-served path, and back it up separately from the database
- The default 25MB limit (`ATTACHMENT_MAX_BYTES`) helps prevent disk exhaustion, but monitor disk usage

### Agent Access

- Agents that connect via MCP or as runners have access to channel data
- Review which agents have access to sensitive channels
- Agents can read and write to repositories when AVCS is connected — ensure proper access controls on the AVCS server

### Network Security

- Run behind a reverse proxy with TLS termination
- Use `TRUST_PROXY=1` only when behind a trusted reverse proxy
- Keep Node.js and Docker updated to the latest stable versions

## Security Updates

Security fixes are released as soon as possible after disclosure. Watch the repository for security-related releases.