# Risk Profile for Claude Code in Docker

We analyzed the security posture of running Claude Code inside a Docker container. The container runs as the host user's UID/GID (non-root), has no Docker socket, no SSH keys, no AWS credentials, and no git push access.

Seven bind mounts from the host create the attack surface:

- The source repo (read-write)
- `~/.claude.json` (snapshotted copy, read-write inside container — host original is unaffected)
- `~/.claude/` (snapshotted copy, read-write inside container — host original is unaffected)
- `~/.claude/projects/` (direct mount, read-write, for session persistence)
- `~/.claude/history.jsonl` (direct mount, read-write, for session persistence)
- Repo-level `.claude/` (snapshotted copy, read-write inside container — host original is unaffected)
- Repo-level `.mcp.json` (snapshotted copy, read-write inside container — host original is unaffected)

The agent also has unrestricted outbound network access. When `--expose-port` is used, the container can additionally reach host services on the forwarded ports.

## Risk Table

| Risk | Impact | Likelihood |
|---|---|---|
| API key theft | High — plaintext Anthropic key readable inside container via the snapshotted `~/.claude.json`, trivial exfiltration over the open network | Easy |
| Source code exfiltration | High — full read access to the mounted repo + outbound network | Easy |
| Conversation history leak | Medium — session data (`projects/`, `history.jsonl`) is directly mounted read-write; everything else in `~/.claude/` is readable via the snapshotted copy | Easy |
| Conversation history destruction | Medium — session data is directly mounted read-write and not source-controlled; deletion or corruption is not easily reversible | Easy |
| Host service access via forwarded ports | Low–Medium — only when `--expose-port` is used; the container can reach host services on those specific ports via socat, potentially accessing services that only listen on localhost | Requires explicit opt-in |

## Mitigated Risks

**Config tampering → host privilege escalation.** Previously the most critical risk. The `~/.claude/` directory was bind-mounted read-write, allowing code inside the container to poison `settings.json` with broad permission allow-lists (e.g., `Bash(*)`), register malicious hooks, or add rogue MCP servers. These changes would take effect the next time Claude Code ran on the host, which has access to SSH keys, AWS credentials, and the full home directory.

Now mitigated: `~/.claude/` and `~/.claude.json` are snapshotted — copied to a temp directory before being mounted into the container. Writes inside the container modify only the snapshot, not the host originals. Only `projects/` and `history.jsonl` are mounted directly from the host for session persistence. All config files (settings, credentials, commands, plugins — including any future config surfaces) are isolated from the host.

The same approach protects project-level config: the repo's `.claude/` directory and `.mcp.json` are snapshotted before mounting, preventing tampering with project-level hooks, permission allow-lists, MCP server configs, and custom agent definitions.

## Discussion

API key theft and source code exfiltration are high-impact but cannot be mitigated architecturally — the agent needs to read source code to do its job, and the API key is required for it to function. These are accepted risks inherent to the tool's purpose. Conversation history leak and destruction are consequences of session data being mounted read-write for persistence — the agent needs write access to save sessions, which also means it can exfiltrate or destroy them. This data is not source-controlled, so destruction is not easily reversible.

Several other risks were considered and excluded from the table:

- **Git remote history corruption:** the container has no SSH keys and no push access; confirmed via `ssh -T git@github.com` returning Permission denied.
- **Destruction of unpushed local work:** the repo is mounted read-write, so uncommitted changes, local-only branches, and stashes could be destroyed. However, this only affects work that hasn't been pushed, making the blast radius small for teams that push frequently.
- **Host service exposure via port forwarding:** when `--expose-port` is used, socat inside the container forwards traffic from `localhost:<port>` to `host.docker.internal:<port>`. This is opt-in and limited to explicitly specified ports. The risk is that a compromised agent could probe or interact with host services that only bind to localhost (e.g., databases, dev servers). Users should only forward ports they intend the agent to access.

## Trade-offs

- Claude Code inside the container cannot modify project-level config (`.claude/settings.json`, `.claude/CLAUDE.md`, `.mcp.json`, etc.). Project instructions and settings should be set up outside the container.
- Non-session data written to `~/.claude/` inside the container (e.g., telemetry, debug logs, cache) is discarded when the container exits.
- Port forwarding (`--expose-port`) intentionally weakens network isolation for specific ports. Only forward ports for services you want the agent to reach.
