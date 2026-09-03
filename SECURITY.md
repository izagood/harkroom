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

We will acknowledge your report within 48 hours and provide a timeline for the fix. We request that you give us reasonable time to address the vulnerability before disclosing it publicly.

## Self-Hosting Security Considerations

If you are self-hosting murmur, please observe the following security practices:

### Personal Access Tokens (PAT)

- Treat PATs like passwords — never commit them to version control
- Rotate PATs periodically
- Use the minimum required permissions when creating PATs
- Restrict PAT access by IP if your deployment supports it

### Attachment Storage

- The `ATTACHMENT_ROOT` environment variable controls where uploaded files are stored
- Ensure the storage directory is backed up regularly
- Consider using object storage (S3-compatible) in production environments
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