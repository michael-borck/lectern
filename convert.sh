#!/bin/sh
# Convert a PDF into slide PNGs (low-level helper — normally you'd upload
# via the dashboard, which also registers the deck in the database).
# After using this, register the folder with:
#   node scripts/import-deck.js <email> <handle>/<deck-name>
#
# usage: ./convert.sh deck.pdf <handle>/<deck-name>
set -e

if [ -z "$2" ]; then
  echo "usage: ./convert.sh deck.pdf <handle>/<deck-name>" >&2
  exit 1
fi
if ! command -v pdftoppm >/dev/null 2>&1; then
  echo "pdftoppm not found. Install poppler: brew install poppler (or apt install poppler-utils)" >&2
  exit 1
fi

mkdir -p "presentations/$2"
pdftoppm -png -r 150 "$1" "presentations/$2/slide"
echo "done: $(ls "presentations/$2"/slide-*.png 2>/dev/null | wc -l | tr -d ' ') slide(s) in presentations/$2/"
echo "register it: node scripts/import-deck.js <email> $2"
