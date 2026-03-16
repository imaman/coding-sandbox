#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function failMe(message: string): never {
  throw new Error(message);
}

const IMAGE_NAME = "coding-capsule";

// Handle --version ourselves; everything else is forwarded to claude.
const args = process.argv.slice(2);
if (args.includes("--version")) {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

function dockerfile(claudeVersion: string): string {
  return `FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \\
    git \\
    ripgrep \\
    fzf \\
    zsh \\
    locales \\
    less \\
    procps \\
    jq \\
    socat \\
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \\
    && locale-gen \\
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV NODE_OPTIONS=--max-old-space-size=4096

COPY entrypoint.sh /entrypoint.sh

ENV PATH="/home/node/.local/bin:$PATH"

USER node
RUN mkdir -p /home/node/.claude && touch /home/node/.zshrc

WORKDIR /home/node/repo

ENTRYPOINT ["/entrypoint.sh"]
CMD ["zsh"]

RUN curl -fsSL https://claude.ai/install.sh | bash -s ${claudeVersion} \\
    && claude --version
`;
}

const ENTRYPOINT = `#!/bin/bash
set -e

# Forward host ports into the container so that localhost:<port> reaches the host.
if [ -n "\${CAPSULE_FORWARD_PORTS:-}" ]; then
  IFS=',' read -ra PORTS <<< "$CAPSULE_FORWARD_PORTS"
  for port in "\${PORTS[@]}"; do
    socat TCP-LISTEN:"$port",fork,reuseaddr,bind=127.0.0.1 TCP:host.docker.internal:"$port" &
  done
fi

exec "$@"
`;

// Extract --expose-port flags before forwarding the rest to claude.
const exposedPorts: number[] = [];
const claudeArgs: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--expose-port") {
    const raw = args[++i];
    if (raw === undefined) {
      console.error("Error: --expose-port requires a port number");
      process.exit(1);
    }
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`Error: invalid port number: ${raw}`);
      process.exit(1);
    }
    exposedPorts.push(port);
  } else {
    claudeArgs.push(args[i] ?? failMe("unexpected undefined arg"));
  }
}
const repoDir = process.cwd();

if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
  console.error(`Error: ${repoDir} is not a valid directory`);
  process.exit(1);
}

const claudeDir = path.join(os.homedir(), ".claude");
const claudeJson = path.join(os.homedir(), ".claude.json");

// Resolve latest Claude Code version
const claudeVersion = await fetch(
  "https://registry.npmjs.org/@anthropic-ai/claude-code/latest"
)
  .then((r) => {
    if (!r.ok) throw new Error(`npm registry returned ${r.status}`);
    return r.json();
  })
  .then((data: { version: string }) => data.version);
console.log(`Using Claude Code v${claudeVersion}`);

// Create temp build context
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-capsule-"));
fs.writeFileSync(path.join(tmpDir, "Dockerfile"), dockerfile(claudeVersion));
fs.writeFileSync(path.join(tmpDir, "entrypoint.sh"), ENTRYPOINT, {
  mode: 0o755,
});

const repoClaudeDir = path.join(repoDir, ".claude");
const repoMcpJson = path.join(repoDir, ".mcp.json");

type BindMount = {
  host: string;
  mode: "ro" | "rw";
  /** Whether the host path is a directory or a regular file. Defaults to "dir". */
  type?: "dir" | "file";
  /**
   * When set, the host path is copied into a temporary directory before mounting, so
   * the container sees an isolated snapshot rather than the live original. Mounts without
   * this property are bound directly to the host path.
   */
  snapshot?: boolean;
  // Pre-create the container path on the host so Docker doesn't leave
  // root-owned entries (needed for overlay mounts inside an already-mounted volume).
  ensureHost?: boolean;
};

// To add a new bind mount, add one entry here. The processing loop below
// handles staging, mount-point pre-creation, and Docker flag generation.
const mounts: Partial<Record<string, BindMount>> = {
  // Settings and authentication
  "/home/node/.claude.json": { host: claudeJson, mode: "rw", snapshot: true },
  // Home .claude directory (staged copy; session data paths below punch through rw)
  "/home/node/.claude": { host: claudeDir, mode: "rw", snapshot: true },
  // Session data persistence (rw directly into the real ~/.claude)
  "/home/node/.claude/projects": { host: path.join(claudeDir, "projects"), mode: "rw" },
  "/home/node/.claude/history.jsonl": { host: path.join(claudeDir, "history.jsonl"), mode: "rw" },
  // Repository
  [repoDir]: { host: repoDir, mode: "rw" },
  // Repo config overlays (read-only staged copies protect settings from tampering)
  [repoClaudeDir]: { host: repoClaudeDir, mode: "rw", snapshot: true, ensureHost: true },
  [repoMcpJson]: { host: repoMcpJson, mode: "rw", type: "file", snapshot: true, ensureHost: true },
};

// ── Process mount table ───────────────────────────────────────────────
const dockerVolArgs: string[] = [];
const createdMountPoints: string[] = [];

// Sort mounts so that a parent directory is mounted before its children (overlays).
// Plain localeCompare happens to get this right (a parent is always a string prefix of its
// child, so it sorts first), but the explicit startsWith check makes the intent obvious.
function withTrailingSlash(p: string): string {
  return p.endsWith('/') ? p : p + '/';
}
const sortedMounts = Object.entries(mounts).sort(([a], [b]) => {
  const aSlash = withTrailingSlash(a);
  const bSlash = withTrailingSlash(b);
  if (b.startsWith(aSlash)) return -1; // a is parent of b
  if (a.startsWith(bSlash)) return 1; // b is parent of a
  return a.localeCompare(b); // siblings — order is irrelevant for correctness
});

for (const [container, m] of sortedMounts) {
  const mount = m ?? failMe(`missing mount for ${container}`);
  let hostPath = mount.host;

  const entityType = mount.type ?? "dir";

  // Snapshot: copy source into a dedicated temp dir so the container gets an isolated copy.
  if (mount.snapshot) {
    const snapshotDir = fs.mkdtempSync(path.join(tmpDir, "snapshot-"));
    const staged = path.join(snapshotDir, path.basename(hostPath));
    if (entityType === "dir") {
      if (fs.existsSync(hostPath)) {
        fs.cpSync(hostPath, staged, { recursive: true });
      } else {
        fs.mkdirSync(staged);
      }
    } else {
      if (fs.existsSync(hostPath)) {
        fs.copyFileSync(hostPath, staged);
      } else {
        fs.writeFileSync(staged, "");
      }
    }
    hostPath = staged;
  }

  // Ensure the mount-point exists on the host (avoids root-owned leftovers).
  if (mount.ensureHost && !fs.existsSync(container)) {
    if (entityType === "dir") {
      fs.mkdirSync(container);
    } else {
      fs.writeFileSync(container, "");
    }
    createdMountPoints.push(container);
  }

  const spec = `${hostPath}:${container}:${mount.mode}`;
  dockerVolArgs.push("-v", spec);
}

let exitCode = 0;
try {
  // Build
  execFileSync("docker", ["build", "-t", IMAGE_NAME, tmpDir], {
    stdio: "inherit",
  });

  // Port-forwarding args: expose host ports inside the container via socat.
  const portArgs: string[] = [];
  if (exposedPorts.length > 0) {
    portArgs.push(
      "--add-host=host.docker.internal:host-gateway",
      "-e",
      `CAPSULE_FORWARD_PORTS=${exposedPorts.join(",")}`,
    );
  }

  // Run
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-it",
      "--user",
      `${(process.getuid ?? failMe("process.getuid is not available"))()}:${(process.getgid ?? failMe("process.getgid is not available"))()}`,
      "-e",
      "HOME=/home/node",
      "-e",
      `TERM=${process.env.TERM || "xterm-256color"}`,
      "--workdir",
      repoDir,
      ...portArgs,
      ...dockerVolArgs,
      IMAGE_NAME,
      "claude",
      "--dangerously-skip-permissions",
      ...claudeArgs,
    ],
    { stdio: "inherit" }
  );
} catch (e: unknown) {
  if (typeof e === "object" && e !== null && "status" in e && typeof e.status === "number") {
    // Docker ran but exited non-zero; it already printed its error via stdio: "inherit".
    exitCode = e.status;
  } else {
    // Failed to launch Docker (e.g., not installed).
    throw e;
  }
} finally {
  // Clean up mount points we pre-created (see comment at creation site above).
  for (const p of createdMountPoints) {
    fs.rmSync(p, { recursive: true, force: true });
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
process.exit(exitCode);
