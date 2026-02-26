# coding-sandbox

Run Claude Code in a sandboxed Docker container. The agent can read/write files in your repo but cannot access anything else on your machine (no SSH keys, AWS credentials, other repos, etc.).

## Prerequisites

- Docker installed
- Claude Code authenticated on your host machine (run `claude` once and log in)

## Setup

Build the image:

```bash
docker build -t coding-sandbox .
```

## Usage

```bash
./claude-yolo /path/to/repo
```

This runs Claude Code in yolo mode (auto-approves all actions) against the given repo.

## What's sandboxed

- The container's filesystem is read-only (except for the mounted repo and `/tmp`)
- Your Claude auth credentials are mounted read-only
- No access to `~/.ssh`, `~/.aws`, `~/.config`, or any other host files
- Network is open (the agent needs it for npm, docs, etc.)

## Undoing changes

The agent can only modify files in the repo you passed in. Since it's source-controlled:

```bash
cd /path/to/repo
git checkout .
git clean -fd
```
