#!/usr/bin/env bash
#
# Publish docs/ to index.rushogen.com.
#
#   deploy/publish.sh <ssh-user>            dry run, prints what would change
#   deploy/publish.sh <ssh-user> --live     actually copies
#
# WHY THIS IS NOT PART OF THE CRAWL WORKFLOW
# ------------------------------------------
# The archive is the git repository and the canonical build is the one GitHub
# Actions commits. This copies that build to a server; it is a mirror, not a
# source. If this machine, this script and the VPS all vanish, nothing is lost,
# which is the property that made GitHub Pages the right home in the first place.
#
# SAFETY
# ------
# rushogen.com serves the consulting site from the same box. The destination
# below is a separate docroot and the script refuses to run against anything
# else. --delete is used, which is why the destination is checked twice and why
# the default is a dry run.
set -euo pipefail

HOST=index.rushogen.com
DEST=/var/www/index.rushogen.com
USER_AT="${1:-}"
LIVE="${2:-}"

if [ -z "$USER_AT" ]; then
  echo "usage: deploy/publish.sh <ssh-user> [--live]" >&2
  exit 64
fi

case "$DEST" in
  /var/www/index.rushogen.com) ;;
  *) echo "refusing: destination is not the index docroot" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -f "$ROOT/docs/index.html" ]; then
  echo "refusing: $ROOT/docs/index.html is missing -- run npm run build first" >&2
  exit 1
fi

# A build that is not the committed one would publish something nobody can
# check out later, which defeats the point of the archive.
if [ -n "$(git -C "$ROOT" status --porcelain docs)" ]; then
  echo "refusing: docs/ has uncommitted changes. Commit the build you are publishing." >&2
  exit 1
fi

FLAGS=(-az --delete --checksum --human-readable --itemize-changes)
[ "$LIVE" = "--live" ] || FLAGS+=(--dry-run)

echo "commit:      $(git -C "$ROOT" rev-parse --short HEAD)"
echo "destination: ${USER_AT}@${HOST}:${DEST}/"
[ "$LIVE" = "--live" ] || echo "MODE:        dry run (pass --live to copy)"
echo

rsync "${FLAGS[@]}" "$ROOT/docs/" "${USER_AT}@${HOST}:${DEST}/"

if [ "$LIVE" = "--live" ]; then
  echo
  echo "published $(git -C "$ROOT" rev-parse --short HEAD) to https://${HOST}/"
fi
