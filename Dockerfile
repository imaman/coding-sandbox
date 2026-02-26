FROM node:20-slim

# Tools the agent commonly needs at runtime
RUN apt-get update && apt-get install -y git curl jq ncurses-base && rm -rf /var/lib/apt/lists/*

# Install Claude Code using the official installer
RUN curl -fsSL https://claude.ai/install.sh | bash

# The installer puts the binary in /root/.local/bin/ which isn't on PATH for other users
# Symlink it to a standard location so it's accessible after we switch to non-root
RUN ln -s /root/.local/bin/claude /usr/local/bin/claude

# Run as the non-root 'node' user (provided by the base image)
# This ensures ~/.claude maps to /home/node/.claude as expected
USER node

WORKDIR /repo
