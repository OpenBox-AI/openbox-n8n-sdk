#!/usr/bin/env bash
# sync-credential-tests.sh
#
# Reads the official n8n credential test implementations from the running n8n
# container and saves them as JS reference files under scripts/reference/.
# Re-run this whenever n8n is upgraded to check for upstream changes.
#
# Usage:
#   ./scripts/sync-credential-tests.sh [container-name]
#   ./scripts/sync-credential-tests.sh n8n-n8n-1

set -euo pipefail

CONTAINER="${1:-n8n-n8n-1}"
OUTDIR="$(dirname "$0")/reference"
mkdir -p "$OUTDIR"

echo "Container : $CONTAINER"
echo "Output    : $OUTDIR"
echo ""

# ── Locate n8n-nodes-base inside the container ───────────────────────────────

N8N_BASE=$(docker exec "$CONTAINER" node -e "
  const fs = require('fs');
  const paths = require.resolve.paths('n8n-nodes-base') || [];
  for (const p of paths) {
    const candidate = p + '/n8n-nodes-base';
    if (fs.existsSync(candidate + '/package.json')) { console.log(candidate); process.exit(0); }
  }
  // fallback: scan filesystem
  const { execSync } = require('child_process');
  const out = execSync(
    'find /usr/local/lib/node_modules/n8n/node_modules -maxdepth 5 -name package.json -path \"*/n8n-nodes-base/package.json\" 2>/dev/null | head -1'
  ).toString().trim();
  console.log(out.replace('/package.json', ''));
" 2>/dev/null)

if [ -z "$N8N_BASE" ]; then
  echo "ERROR: could not locate n8n-nodes-base inside container '$CONTAINER'."
  echo "       Is the container running? Try: docker ps"
  exit 1
fi
echo "n8n-nodes-base : $N8N_BASE"
echo ""

# ── Helper ────────────────────────────────────────────────────────────────────

extract() {
  local label="$1"
  local src="$2"
  local dest="$OUTDIR/$3"
  if docker exec "$CONTAINER" test -f "$src" 2>/dev/null; then
    docker exec "$CONTAINER" cat "$src" > "$dest"
    echo "  OK  $label -> $(basename "$dest")"
  else
    echo "  --  $label (not found at $src)"
  fi
}

# ── Postgres ──────────────────────────────────────────────────────────────────

echo "=== Postgres ==="
extract "credentialTest" \
  "$N8N_BASE/dist/nodes/Postgres/v2/methods/credentialTest.js" \
  "postgres.credentialTest.js"

extract "transport" \
  "$N8N_BASE/dist/nodes/Postgres/v2/transport/index.js" \
  "postgres.transport.js"

# ── MySQL ─────────────────────────────────────────────────────────────────────

echo "=== MySQL ==="
extract "credentialTest" \
  "$N8N_BASE/dist/nodes/MySql/v2/methods/credentialTest.js" \
  "mysql.credentialTest.js"

extract "transport" \
  "$N8N_BASE/dist/nodes/MySql/v2/transport/index.js" \
  "mysql.transport.js"

# ── MongoDB ───────────────────────────────────────────────────────────────────

echo "=== MongoDB ==="
extract "GenericFunctions (conn utils)" \
  "$N8N_BASE/dist/nodes/MongoDb/GenericFunctions.js" \
  "mongodb.GenericFunctions.js"

extract "MongoDb.node (credential wiring)" \
  "$N8N_BASE/dist/nodes/MongoDb/MongoDb.node.js" \
  "mongodb.node.js"

# ── Redis ─────────────────────────────────────────────────────────────────────

echo "=== Redis ==="
extract "utils (redisConnectionTest)" \
  "$N8N_BASE/dist/nodes/Redis/utils.js" \
  "redis.utils.js"

extract "Redis.node (credential wiring)" \
  "$N8N_BASE/dist/nodes/Redis/Redis.node.js" \
  "redis.node.js"

# ── Oracle ───────────────────────────────────────────────────────────────────

echo "=== Oracle ==="
extract "credentialTest" \
  "$N8N_BASE/dist/nodes/Oracle/Sql/methods/credentialTest.js" \
  "oracle.credentialTest.js"

# ── Report ────────────────────────────────────────────────────────────────────

echo ""
echo "Reference files written to $OUTDIR/"
echo "Compare against src/shared/credential-test.ts to verify parity."
