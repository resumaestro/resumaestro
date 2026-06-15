#!/usr/bin/env bash
set -euo pipefail

CF_TOKEN="cfoat_dkSade-igRJ_CO11tHmx3MWpU4RXPXnSE0bm37Ux6_8.xZB37SELLMDBvK2ww-9oUjKOx3ttb_VQvkIl8PlAm3I"
ACCOUNT_ID="281f6b8969eb59a0dec34daaafd69a29"
SRC="job-source"
DST="resumaestro-source"
TMPDIR_BASE="$HOME/tmp-r2-migrate"
mkdir -p "$TMPDIR_BASE"

# Fetch all keys
KEYS=$(curl -s "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${SRC}/objects?limit=1000" \
  -H "Authorization: Bearer ${CF_TOKEN}" | python3 -c "import sys,json; d=json.load(sys.stdin); [print(o['key']) for o in d['result']]")

echo "Found keys:"
echo "$KEYS"
echo ""

while IFS= read -r key; do
  # Skip files already migrated under new paths
  if [[ "$key" == "BASE_RESUME.html" || "$key" == "source.yml" ]]; then
    echo "SKIP (already migrated): $key"
    continue
  fi

  TMPFILE="$TMPDIR_BASE/$(echo "$key" | tr '/' '_')"

  echo "Downloading: $key"
  wrangler r2 object get "${SRC}/${key}" --file "$TMPFILE" --remote 2>&1 | grep -v "^$" | grep -v "^─"

  echo "Uploading: $key → ${DST}/${key}"
  wrangler r2 object put "${DST}/${key}" --file "$TMPFILE" --remote 2>&1 | grep -v "^$" | grep -v "^─"

  rm -f "$TMPFILE"
  echo "Done: $key"
  echo ""
done <<< "$KEYS"

echo "Migration complete."
