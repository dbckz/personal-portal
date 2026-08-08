#!/bin/bash
# Staging instance of the portal. Runs the staging git worktree in dev mode on
# port 3002 (portal-staging.localhost) against a COPY of the data directory, so
# in-progress work can be exercised without touching the production app or its
# data. Refresh the data copy with:
#   rsync -a --delete ~/.claude/data/portal/ ~/.claude/data/portal-staging/
cd /Users/dave/working_dir/github/dbckz/personal-portal-staging || exit 1
export PORTAL_DATA_DIR="$HOME/.claude/data/portal-staging"
exec npx next dev -p 3002
