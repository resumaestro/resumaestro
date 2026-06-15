#!/usr/bin/env bash
# Migrates Claude Code project memory and conversation history
# from ./job-slack to ./resumaestro/resumaestro.

set -euo pipefail

SRC_DIR="$HOME/.claude/projects/-Users-cameronaziz-engineering-job-slack"
DST_DIR="$HOME/.claude/projects/-Users-cameronaziz-engineering-resumaestro-resumaestro"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "Source not found: $SRC_DIR"
  exit 1
fi

if [[ -d "$DST_DIR" ]]; then
  echo "Destination already exists: $DST_DIR"
  echo "Aborting to avoid overwrite. Remove it first if you want to proceed."
  exit 1
fi

mkdir -p "$DST_DIR"
cp -r "$SRC_DIR/." "$DST_DIR/"

echo "Copied Claude project data:"
echo "  from: $SRC_DIR"
echo "    to: $DST_DIR"
echo ""
echo "Once you've moved the repo to ~/engineering/resumaestro/resumaestro,"
echo "Claude Code will pick up the history and memory automatically."
echo ""
echo "You can remove the old directory when ready:"
echo "  rm -rf \"$SRC_DIR\""
