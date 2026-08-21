#!/bin/sh
# Convert a PDF (exported from PowerPoint/Keynote) into slide PNGs in slides/
# usage: ./convert.sh deck.pdf
set -e

if [ -z "$1" ]; then
  echo "usage: ./convert.sh deck.pdf" >&2
  exit 1
fi
if ! command -v pdftoppm >/dev/null 2>&1; then
  echo "pdftoppm not found. Install poppler: brew install poppler (or apt install poppler-utils)" >&2
  exit 1
fi

mkdir -p slides
pdftoppm -png -r 150 "$1" slides/slide
echo "done: $(ls slides/*.png 2>/dev/null | wc -l | tr -d ' ') slide(s) in slides/"
