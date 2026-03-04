#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

const IMAGE_NAME = "coding-capsule";

function dockerfile(claudeVersion) {
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

RUN curl -fsSL https://claude.ai/install.sh | bash -s ${claudeVersion}
`;
}

const ENTRYPOINT = `#!/bin/bash
set -e
exec "$@"
`;

const argv = yargs(hideBin(process.argv))
  .usage("$0 <repo-dir> [claude args..]")
  .command("$0 <repo-dir>", "Run Claude Code in a sandboxed Docker container", (yargs) => {
    yargs.positional("repo-dir", {
      describe: "Path to the repository directory to mount",
      type: "string",
    });
  })
  .strict(false)
  .help()
  .version()
  .parseSync();

const repoDir = path.resolve(argv.repoDir);
const claudeArgs = argv._.map(String);

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
  .then((data) => data.version);
console.log(`Using Claude Code v${claudeVersion}`);

// Create temp build context
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-capsule-"));
fs.writeFileSync(path.join(tmpDir, "Dockerfile"), dockerfile(claudeVersion));
fs.writeFileSync(path.join(tmpDir, "entrypoint.sh"), ENTRYPOINT, {
  mode: 0o755,
});

// Copy ~/.claude/ to tmpDir for read-only mounting.
// Session data paths are mounted back rw from the host for persistence.
const stagedHomeClaudeDir = path.join(tmpDir, "home-claude");
fs.cpSync(claudeDir, stagedHomeClaudeDir, { recursive: true });
const sessionDataPaths = ["projects", "history.jsonl"];

// Stage repo-level config for read-only overlay mounts.
// Protects .claude/ (settings, agents, MCP config) from tampering inside the container.
const repoConfigMounts = [];

const repoClaudeDir = path.join(repoDir, ".claude");
const stagedClaudeDir = path.join(tmpDir, "repo-claude");
if (fs.existsSync(repoClaudeDir)) {
  fs.cpSync(repoClaudeDir, stagedClaudeDir, { recursive: true });
} else {
  fs.mkdirSync(stagedClaudeDir);
}
repoConfigMounts.push("-v", `${stagedClaudeDir}:${repoClaudeDir}:ro`);

const repoMcpJson = path.join(repoDir, ".mcp.json");
const stagedMcpJson = path.join(tmpDir, "repo-mcp.json");
if (fs.existsSync(repoMcpJson)) {
  fs.copyFileSync(repoMcpJson, stagedMcpJson);
} else {
  fs.writeFileSync(stagedMcpJson, "");
}
repoConfigMounts.push("-v", `${stagedMcpJson}:${repoMcpJson}:ro`);

// Pre-create mount points so Docker doesn't leave root-owned entries on the host.
// Here's what happens at mounting time:
// 1. Docker bind-mounts repoDir into the container at the same path
// 2. Docker then overlays staged copies on top: stagedClaudeDir → <repoDir>/.claude,
//    stagedMcpJson → <repoDir>/.mcp.json
// 3. For these overlay mounts, Docker needs the target paths to exist inside the
//    already-mounted repoDir — which means they must exist on the host filesystem
// 4. If they don't exist, the Docker daemon (running as root) creates them as
//    root-owned directories (even for targets that should be files, e.g., .mcp.json)
// 5. After the container exits, these root-owned entries remain in the user's repo
// By creating them ourselves beforehand (as the current user) we avoid step 4.
// They are cleaned up on exit if we were the ones who created them.
const createdMountPoints = [];
if (!fs.existsSync(repoClaudeDir)) {
  fs.mkdirSync(repoClaudeDir);
  createdMountPoints.push(repoClaudeDir);
}
if (!fs.existsSync(repoMcpJson)) {
  fs.writeFileSync(repoMcpJson, "");
  createdMountPoints.push(repoMcpJson);
}

let exitCode = 0;
try {
  // Build
  execFileSync("docker", ["build", "-t", IMAGE_NAME, tmpDir], {
    stdio: "inherit",
  });

  // Run
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-it",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "-e",
      "HOME=/home/node",
      "-e",
      `TERM=${process.env.TERM || "xterm-256color"}`,
      "--workdir",
      repoDir,
      "-v",
      `${stagedHomeClaudeDir}:/home/node/.claude:rw`,
      "-v",
      `${claudeJson}:/home/node/.claude.json:rw`,
      ...sessionDataPaths.flatMap((p) => [
        "-v",
        `${path.join(claudeDir, p)}:/home/node/.claude/${p}`,
      ]),
      "-v",
      `${repoDir}:${repoDir}`,
      ...repoConfigMounts,
      IMAGE_NAME,
      "claude",
      "--dangerously-skip-permissions",
      ...claudeArgs,
    ],
    { stdio: "inherit" }
  );
} catch (e) {
  if (e.status != null) {
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
