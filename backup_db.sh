#!/usr/bin/env bash
# WAL-safe snapshot of data/library.sqlite3 into a timestamped, never-overwritten
# copy. A plain `cp` of the main db file alone can miss rows still sitting in
# the -wal file (this bit us once: a snapshot read 52 annotations when the live
# db actually had 87). `sqlite3 .backup` checkpoints the WAL and copies a
# consistent snapshot in one step, safe to run while the server is up.
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
db="$project_dir/data/library.sqlite3"
dest_dir="$project_dir/data"
timestamp="$(date +%Y%m%d_%H%M%S)"
dest="$dest_dir/library.sqlite3.bak-$timestamp"

if [[ ! -f "$db" ]]; then
  echo "No database at $db" >&2
  exit 1
fi

sqlite3 "$db" ".backup '$dest'"
echo "Backed up $db -> $dest"
