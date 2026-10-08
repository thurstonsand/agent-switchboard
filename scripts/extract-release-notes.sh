#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 vX.Y.Z" >&2
  exit 2
fi

awk -v version="${1#v}" '
  # Headings look like "## X.Y.Z — YYYY-MM-DD".
  index($0, "## " version " ") == 1 {
    capture = 1
    found = 1
    print
    next
  }

  capture && /^## / {
    exit
  }

  capture {
    print
  }

  END {
    if (!found) {
      printf "release notes not found for v%s\n", version > "/dev/stderr"
      exit 1
    }
  }
' CHANGELOG.md
