#!/usr/bin/env bash
#
# Publish the SPA (app/) to index.rushogen.com.
#
#   deploy/publish-app.sh <ssh-user>            dry run, prints what would change
#   deploy/publish-app.sh <ssh-user> --live     actually copies
#
# The app is a static bundle (Vite build) served from this origin with no runtime
# third-party request. It reads the published archive JSON at /api/*.json, so the
# deploy assembles: the built app + the latest api/ from the data build + the
# text disclosures, then mirrors that tree to the docroot. Same VPS, same docroot
# guard, same --delete safety as publish.sh.
set -euo pipefail

HOST=index.rushogen.com
DEST=/var/www/index.rushogen.com
USER_AT="${1:-}"
LIVE="${2:-}"

if [ -z "$USER_AT" ]; then
  echo "usage: deploy/publish-app.sh <ssh-user> [--live]" >&2
  exit 64
fi

case "$DEST" in
  /var/www/index.rushogen.com) ;;
  *) echo "refusing: destination is not the index docroot" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 1. Build the app.
( cd "$ROOT/app" && npm run build )

STAGE="$ROOT/app/dist"
if [ ! -f "$STAGE/index.html" ]; then
  echo "refusing: $STAGE/index.html is missing -- the build did not produce output" >&2
  exit 1
fi

# 2. Stage the latest archive data over the bundled snapshot, plus disclosures.
mkdir -p "$STAGE/api"
cp "$ROOT"/docs/api/*.json "$STAGE/api/" 2>/dev/null || { echo "refusing: no docs/api/*.json -- run npm run build (data) first" >&2; exit 1; }
for f in methodology.txt corrections.txt crawler.txt robots.txt; do
  [ -f "$ROOT/docs/$f" ] && cp "$ROOT/docs/$f" "$STAGE/$f"
done

# 3. Mirror. --delete so a removed asset is removed on the server too.
FLAGS=(-az --delete --checksum --human-readable --itemize-changes)
[ "$LIVE" = "--live" ] || FLAGS+=(--dry-run)

echo "commit:      $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo n/a)"
echo "destination: ${USER_AT}@${HOST}:${DEST}/"
[ "$LIVE" = "--live" ] || echo "MODE:        dry run (pass --live to copy)"
echo

rsync "${FLAGS[@]}" "$STAGE/" "${USER_AT}@${HOST}:${DEST}/"

if [ "$LIVE" = "--live" ]; then
  echo
  echo "published the app to https://${HOST}/"
fi
