#!/bin/sh
# Convert a PDF (exported from PowerPoint/Keynote) into a deck of slide PNGs.
# usage: ./convert.sh deck.pdf [deck-name]
# Output: presentations/<deck-name>/slide-*.png
set -e

if [ -z "$1" ]; then
  echo "usage: ./convert.sh deck.pdf [deck-name]" >&2
  exit 1
fi
if ! command -v pdftoppm >/dev/null 2>&1; then
  echo "pdftoppm not found. Install poppler: brew install poppler (or apt install poppler-utils)" >&2
  exit 1
fi

if [ -n "$2" ]; then
  NAME="$2"
else
  # slugify the PDF filename: lowercase, non-alphanumerics -> dashes
  NAME=$(basename "$1" .pdf | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-*//; s/-*$//')
fi

case "$NAME" in
  reveal|sync|decks.json|viewer.js|style.css|favicon.ico)
    echo "'$NAME' is a reserved name, pick another deck name" >&2
    exit 1
    ;;
esac

mkdir -p "presentations/$NAME"
pdftoppm -png -r 150 "$1" "presentations/$NAME/slide"
echo "done: $(ls "presentations/$NAME"/slide-*.png 2>/dev/null | wc -l | tr -d ' ') slide(s) in presentations/$NAME/"
echo "view at /$NAME/"
