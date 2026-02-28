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

USER node
RUN curl -fsSL https://claude.ai/install.sh | bash -s ${claudeVersion}
ENV PATH="/home/node/.local/bin:$PATH"

RUN mkdir -p /home/node/.claude && touch /home/node/.zshrc

WORKDIR /home/node/repo

ENTRYPOINT ["/entrypoint.sh"]
CMD ["zsh"]
`;
}

const ENTRYPOINT = `#!/bin/bash
set -e

# Copy host credentials into container (so writes don't affect the host)
cp /host-claude/.credentials.json /home/node/.claude/.credentials.json 2>/dev/null || true
cp /host-claude/config.json /home/node/.claude/config.json 2>/dev/null || true
cp /host-claude/settings.json /home/node/.claude/settings.json 2>/dev/null || true
cp /host-claude.json /home/node/.claude.json 2>/dev/null || true

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
      "-e",
      `TERM=${process.env.TERM || "xterm-256color"}`,
      "-v",
      `${claudeDir}:/host-claude:ro`,
      "-v",
      `${claudeJson}:/host-claude.json:ro`,
      "-v",
      `${repoDir}:/home/node/repo`,
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
