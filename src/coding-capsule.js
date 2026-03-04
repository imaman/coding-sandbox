#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
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

// Ensure config files exist on the host so we can mount them read-only.
// An empty file is harmless and prevents code inside the container from
// creating a new settings file with malicious hooks or permission allow-lists.
const configFiles = ["settings.json", "settings.local.json"];
for (const f of configFiles) {
  const p = path.join(claudeDir, f);
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, "");
  }
}

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
repoConfigMounts.push("-v", `${stagedClaudeDir}:${repoClaudeDir}:rw`);

const repoMcpJson = path.join(repoDir, ".mcp.json");
const stagedMcpJson = path.join(tmpDir, "repo-mcp.json");
if (fs.existsSync(repoMcpJson)) {
  fs.copyFileSync(repoMcpJson, stagedMcpJson);
} else {
  fs.writeFileSync(stagedMcpJson, "");
}
repoConfigMounts.push("-v", `${stagedMcpJson}:${repoMcpJson}:rw`);

try {
  // Build
  execFileSync("docker", ["build", "-t", IMAGE_NAME, tmpDir], {
    stdio: "inherit",
  });

  // Run
  const child = spawn(
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
      `${claudeDir}:/home/node/.claude`,
      "-v",
      `${claudeJson}:/home/node/.claude.json:rw`,
      ...configFiles.flatMap((f) => [
        "-v",
        `${path.join(claudeDir, f)}:/home/node/.claude/${f}:rw`,
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

  child.on("exit", (code) => process.exit(code || 0));
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
