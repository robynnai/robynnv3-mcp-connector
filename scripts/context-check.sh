#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
status=0
cd "$ROOT" || exit 1

section() {
  printf '\n== %s ==\n' "$1"
}

section "Repository"
git -C "$ROOT" status --short --branch || status=1

section "Agent context docs"
for file in \
  "$ROOT/AGENTS.md" \
  "$ROOT/CLAUDE.md" \
  "$ROOT/docs/agent-context/START_HERE.md" \
  "$ROOT/docs/agent-context/CURRENT_STATE.md" \
  "$ROOT/docs/agent-context/HANDOFF.md"
do
  if [ -f "$file" ]; then
    printf 'ok %s\n' "${file#$ROOT/}"
  else
    printf 'missing %s\n' "${file#$ROOT/}"
    status=1
  fi
done

section "Beads"
if ! command -v bd >/dev/null 2>&1; then
  printf 'missing bd command; install Beads before using repo-local task memory\n'
  exit 1
fi

if [ ! -d "$ROOT/.beads" ]; then
  printf 'missing .beads directory\n'
  exit 1
fi

chmod 700 "$ROOT/.beads" 2>/dev/null || true
git -C "$ROOT" config --local beads.role maintainer || true

if ! bd ready --readonly --json >/tmp/robynn-mcp-bd-ready.json 2>/tmp/robynn-mcp-bd-ready.err; then
  printf 'bd ready failed; bootstrapping from tracked Beads data\n'
  bd bootstrap --yes || status=1
fi

bd ready --readonly --json || status=1

exit "$status"
