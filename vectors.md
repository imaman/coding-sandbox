# Attack vectors

Catalog of attack vectors when running Claude Code in `--dangerously-skip-permissions` mode inside this Docker sandbox. Each vector notes what the sandbox mitigates and what remains exposed.

---

## 1. Prompt injection

**Status: unmitigated (by design)**

A malicious instruction hidden in a repo file (code comment, README, config, issue template, dependency manifest) can hijack the agent. Because `--dangerously-skip-permissions` auto-approves every tool call, the agent will execute whatever the injected prompt asks — run shell commands, write files, make network requests — with no human confirmation step.

This is the root vector. Every other vector below becomes exploitable once prompt injection succeeds.

**Countermeasures:**
- None within this sandbox. The entire point of the Docker container is to limit the blast radius *after* injection succeeds.
- Upstream: Claude's own prompt-injection resistance is the only defense, which is imperfect.

---

## 2. Credential exfiltration

**Status: partially mitigated**

The entrypoint (`entrypoint.sh`) copies `~/.claude/.credentials.json`, `config.json`, `settings.json`, and `~/.claude.json` into the container so the agent can authenticate. These files are readable by the `node` user. Since the network is unrestricted, a hijacked agent can `curl` the credentials to an external server.

What's protected: the host's `~/.ssh`, `~/.aws`, `~/.config`, browser cookies, and all other host files are never mounted. Only Claude session credentials are exposed.

**Countermeasures:**
- Add an egress proxy (e.g., squid) that allowlists only necessary domains (npmjs.org, github.com, api.anthropic.com, etc.) to block exfiltration channels.
- Use `--network=none` and pre-install all dependencies (eliminates network exfiltration entirely, but breaks `npm install`, web search, etc.).
- Rotate credentials after each session.

---

## 3. Source code exfiltration

**Status: unmitigated**

The repo is mounted read-write at `/home/node/repo`. Combined with unrestricted network access, a hijacked agent can read any file in the repo and send it to an external server. This is inherent to the design — the agent *needs* to read the code to do its job, and it *needs* network access for packages and docs.

**Countermeasures:**
- Egress proxy restricting outbound destinations (same as credential exfiltration).
- Only mount repos that don't contain secrets. Audit for `.env` files, hardcoded API keys, etc. before launching the sandbox.

---

## 4. Repo tampering

**Status: partially mitigated**

The repo is mounted read-write (`-v "$REPO_DIR:/home/node/repo"` with no `:ro` flag). The agent can write arbitrary files: inject backdoors, introduce subtle bugs, modify CI configs, add malicious post-install scripts, etc. These changes persist on the host after the container exits.

What mitigates this: the repo is source-controlled. All changes are visible via `git diff` and reversible with `git checkout . && git clean -fd`. However, this only helps if the user actually reviews the diff before committing/pushing.

**Countermeasures:**
- Always review `git diff` after a session before committing.
- Run the sandbox against a throwaway clone or worktree, not your main checkout.
- Use git hooks or CI checks to catch suspicious patterns (e.g., obfuscated code, encoded strings, unexpected file types).

---

## 5. Internal network access

**Status: unmitigated**

The container uses the host's default network (no `--network` flag is set, which defaults to `bridge` mode with NAT). The agent can reach:
- LAN services (databases, admin panels, internal APIs)
- Cloud metadata endpoints (`169.254.169.254` on AWS/GCP/Azure — can leak IAM credentials, instance identity, user-data scripts)
- Other containers on the same Docker network
- Localhost services on the host (via `host.docker.internal` or the gateway IP)

**Countermeasures:**
- Use `--network=none` if the task doesn't require network access.
- Use an egress proxy or firewall rules to block RFC 1918 ranges and link-local addresses (`169.254.0.0/16`).
- On cloud instances, use IMDSv2 (requires a PUT hop that's harder to exploit from inside a container) and restrict the instance's IAM role to minimum permissions.
- Run Docker with a custom network that has no route to the host or LAN.

---

## 6. Supply-chain attacks via dependencies

**Status: unmitigated**

The agent can run `npm install`, `pip install`, or any other package manager with unrestricted network access. A hijacked agent can install a malicious package whose post-install script runs arbitrary code inside the container. Even without prompt injection, the agent may install a typosquatted or compromised package in good faith.

Since the container's filesystem is not set to read-only (no `--read-only` flag in the `docker run` command), malicious install scripts have full write access within the container.

**Countermeasures:**
- Use `--read-only` on the container filesystem and only whitelist `/home/node/repo` and `/tmp` as writable (via `--tmpfs /tmp`).
- Pin dependency versions and use lockfiles.
- Use `--network=none` with a pre-populated package cache.
- Run `npm install --ignore-scripts` to skip post-install hooks.

---

## 7. Docker escape

**Status: mitigated (low residual risk)**

A container breakout — escaping the Docker sandbox to gain access to the host — is theoretically possible via:
- Kernel vulnerabilities (the container shares the host kernel)
- Docker runtime bugs (runc, containerd)
- Misconfigured capabilities or mounts

This sandbox runs as the unprivileged `node` user (not root), doesn't add extra capabilities (`--privileged` is not set), and doesn't mount the Docker socket. These choices reduce the attack surface significantly. A breakout would require an unpatched kernel or runtime vulnerability.

**Countermeasures:**
- Keep Docker and the host kernel up to date.
- Add `--cap-drop=ALL` to remove all Linux capabilities.
- Add `--security-opt=no-new-privileges` to prevent privilege escalation.
- Use a seccomp profile to restrict available syscalls.
- Use gVisor (`--runtime=runsc`) or Kata Containers for stronger isolation.
- For maximum isolation, use a dedicated VM instead of Docker.

---

## 8. Resource exhaustion

**Status: unmitigated**

The `docker run` command sets no resource limits. A hijacked (or buggy) agent can:
- Fork-bomb the host (`:(){ :|:& };:`)
- Allocate unbounded memory until the OOM killer fires
- Fill disk by writing large files to the repo mount or `/tmp`
- Spin CPU indefinitely

This can crash or severely degrade the host system.

**Countermeasures:**
- Set memory limits: `--memory=4g --memory-swap=4g`
- Set CPU limits: `--cpus=2`
- Set process limits: `--pids-limit=256`
- Set disk quotas or use `--tmpfs /tmp:size=1g` to cap temp file usage.
- Use `--storage-opt size=10G` (requires backing filesystem support) to limit the container's writable layer.

---

## Summary

| # | Vector | Status | Key gap |
|---|--------|--------|---------|
| 1 | Prompt injection | Unmitigated | Root cause; sandbox limits blast radius only |
| 2 | Credential exfiltration | Partial | Claude creds copied in + open network |
| 3 | Source code exfiltration | Unmitigated | Readable repo + open network |
| 4 | Repo tampering | Partial | Write access, but git makes it reversible |
| 5 | Internal network access | Unmitigated | Default bridge network; can reach LAN/metadata |
| 6 | Supply-chain dependencies | Unmitigated | Unrestricted install + no read-only fs |
| 7 | Docker escape | Mitigated | Low risk; unprivileged user, no extra caps |
| 8 | Resource exhaustion | Unmitigated | No cgroup/memory/CPU/pid limits set |
