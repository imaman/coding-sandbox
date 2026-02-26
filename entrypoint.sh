#!/bin/bash
set -e

# Copy host credentials into container (so writes don't affect the host)
cp /host-claude/.credentials.json /home/node/.claude/.credentials.json 2>/dev/null || true
cp /host-claude/config.json /home/node/.claude/config.json 2>/dev/null || true
cp /host-claude/settings.json /home/node/.claude/settings.json 2>/dev/null || true
cp /host-claude.json /home/node/.claude.json 2>/dev/null || true

exec "$@"
