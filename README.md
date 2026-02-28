# coding-capsule

Run Claude Code in a sandboxed Docker container. The agent can read/write files in your repo but cannot access anything else on your machine (no SSH keys, AWS credentials, other repos, etc.).

## Prerequisites

- Docker installed
- Claude Code authenticated on your host machine (run `claude` once and log in)

## Setup

Build the image:

```bash
docker build -t coding-capsule .
```

## Usage

```bash
./coding-capsule /path/to/repo
```

This runs Claude Code in yolo mode (auto-approves all actions) against the given repo.

## What's sandboxed

- The container's filesystem is read-only (except for the mounted repo and `/tmp`)
- Your Claude auth credentials are mounted read-only
- No access to `~/.ssh`, `~/.aws`, `~/.config`, or any other host files
- Network is open (the agent needs it for npm, docs, etc.)

> [!WARNING]
> Your Claude session credentials are readable inside the container. A prompt injection attack (e.g., malicious instructions hidden in a repo file) could read the credentials and exfiltrate them over the network. The token is only useful for Claude API calls, not for accessing your machine or GitHub, but be aware of this risk. To mitigate it, you could add an egress proxy that restricts outbound traffic to known-good domains.

## Rationale

### The problem

Running a coding agent in yolo mode (auto-approve all actions) is convenient but risky. A bad actor can embed prompt injection instructions in repo files (README, code comments, issue descriptions) that trick the agent into running arbitrary commands on your machine — deleting files, exfiltrating secrets, installing backdoors, etc.

We don't care about the agent messing with the repo itself — it's source-controlled and trivially reversible with `git checkout . && git clean -fd`. The threat is the agent reaching outside the repo to the rest of the local machine.

### Approaches considered

**Claude Code hooks (command blocklist).** Configure hooks that intercept every Bash call and block patterns like `rm -rf ~`, `curl ... | sh`, access to `~/.ssh`, etc. This is easy to set up but fundamentally a blocklist — a sufficiently creative injection can bypass it via encoding, aliasing, or indirect execution. It's a speed bump, not a wall.

**Bubblewrap (`bwrap`).** A lightweight Linux sandboxing tool that uses kernel namespaces (same as Docker) but without a daemon, images, or root access. You selectively mount only the directories the process needs. The advantage over Docker is that auth "just works" since it runs natively on the host. The downside is more fiddly to set up and less familiar to most people.

**Docker with `--network=none`.** The strongest isolation — no filesystem access outside the mounted repo, no network. But coding agents legitimately need network access for installing packages, reading library docs, searching npm, etc. So this is too restrictive.

**Docker with egress proxy.** Run a filtering proxy (e.g., squid) that only allows traffic to known-good domains (npmjs.org, github.com, stackoverflow.com, etc.). This prevents exfiltration while allowing legitimate network use. Effective but high maintenance — you need to keep the allowlist up to date.

**Docker with read-only filesystem and open network.** The container can only write to the mounted repo and `/tmp`. Network is unrestricted. The agent can't touch anything on the host machine, but it can make outbound network requests. The only sensitive data it could exfiltrate is the repo's source code and the mounted Claude session credentials.

**Dedicated VM.** Run the agent on a throwaway cloud instance or local VM with nothing of value on it. Strongest isolation but heaviest setup.

### What we chose

Docker with a read-only filesystem and open network. It's the pragmatic sweet spot:

- Fully protects the host machine (no access to SSH keys, AWS creds, other repos, etc.)
- Agent can still use the network for legitimate purposes (npm, docs, etc.)
- Simple to set up — a small Dockerfile and a one-line wrapper script
- Repo damage is irrelevant (source-controlled)

The trade-off is that the Claude session credentials are readable inside the container and could theoretically be exfiltrated over the open network. We accept this because (a) the token is only useful for Claude API calls, and (b) adding an egress proxy to close this gap is possible but adds significant complexity.

## Undoing changes

The agent can only modify files in the repo you passed in. Since it's source-controlled:

```bash
cd /path/to/repo
git checkout .
git clean -fd
```
