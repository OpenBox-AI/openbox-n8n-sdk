#!/bin/sh
# Provisions a local OpenBox stack with everything the n8n example needs.
# Idempotent — short-circuits on a fresh /seed/agent_key that still
# validates against Core. Reachable services are addressed by their docker
# network names; this container joins openbox-local_default.
#
# Steps:
#   1. Flip the api_keys feature flag in postgres (no API exists for it).
#   2. Insert an org X-API-Key row directly (it's just a SHA-256 hash +
#      permissions; the backend's validateApiKey() is a hash lookup, no
#      keycloak/JWT involved).
#   3. Ensure a `default` team exists in keycloak AND postgres (backend's
#      team service queries keycloak; agent_teams FK requires the row).
#   4. Mint the agent via POST /agent/create with the X-API-Key — the
#      response is the only place the runtime `obx_test_*` surfaces.
#   5. Attach deterministic demo guardrails that mirror the hosted policy.
#   6. Persist the runtime key to /seed/agent_key for n8n to consume.
set -eu

KEYCLOAK_URL="${KEYCLOAK_URL:-http://openbox-keycloak:8080}"
BACKEND_URL="${BACKEND_URL:-http://openbox-backend:3000}"
CORE_URL="${CORE_URL:-http://openbox-core-server:8086}"
PG_HOST="${PG_HOST:-openbox-postgres}"
PG_USER="${PG_USER:-postgres}"
PGPASSWORD="${PG_PASSWORD:-password}"
export PGPASSWORD
PG_DB="${PG_DB:-openbox}"

KC_ADMIN_USER="${KC_ADMIN_USER:-admin}"
KC_ADMIN_PASS="${KC_ADMIN_PASS:-admin}"

ORG_REALM="${ORG_REALM:-openbox.local}"
AGENT_NAME="${AGENT_NAME:-n8n-example}"
TEAM_NAME="${TEAM_NAME:-default}"

KEY_FILE="${KEY_FILE:-/seed/agent_key}"

log() { echo "[seed] $*"; }
fail() { echo "[seed] FAIL: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Wait for upstreams.
# ---------------------------------------------------------------------------
wait_http() {
  url=$1; name=$2
  i=0
  until curl -sfo /dev/null --max-time 3 "$url"; do
    i=$((i+1))
    [ $i -ge 60 ] && fail "$name not reachable at $url after 120s"
    sleep 2
  done
  log "$name reachable"
}

log "waiting for upstream services on the openbox network…"
wait_http "$KEYCLOAK_URL/realms/master/.well-known/openid-configuration" keycloak
wait_http "$BACKEND_URL/health" backend
wait_http "$CORE_URL/" core

# ---------------------------------------------------------------------------
# Short-circuit: existing key still valid?
# ---------------------------------------------------------------------------
if [ -f "$KEY_FILE" ] && [ -s "$KEY_FILE" ]; then
  EXISTING=$(cat "$KEY_FILE")
  if curl -sfo /dev/null --max-time 5 -X POST "$CORE_URL/api/v1/governance/evaluate" \
      -H "Authorization: Bearer $EXISTING" \
      -H 'Content-Type: application/json' \
      -d "{\"event_type\":\"WorkflowStarted\",\"workflow_id\":\"seed-probe\",\"run_id\":\"r1\",\"workflow_type\":\"probe\",\"task_queue\":\"seed\",\"source\":\"workflow-telemetry\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" 2>/dev/null; then
    log "existing agent_key valid; nothing to do"
    exit 0
  fi
  log "existing agent_key did not validate; re-provisioning"
fi

# ---------------------------------------------------------------------------
# 1. Flip api_keys + webhooks feature flags. Merge so we don't clobber
#    flags an admin set elsewhere.
# ---------------------------------------------------------------------------
log "enabling api_keys feature for $ORG_REALM"
psql -h "$PG_HOST" -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q -c "
INSERT INTO organization_settings (organization_id, feature_flags)
VALUES ('$ORG_REALM', '{\"api_keys\":true,\"webhooks\":true}')
ON CONFLICT (organization_id) DO UPDATE
SET feature_flags = organization_settings.feature_flags
                  || EXCLUDED.feature_flags;
" >/dev/null

# ---------------------------------------------------------------------------
# 2. Generate org X-API-Key + insert directly. Skips the
#    password-reset → JWT-login → POST /api-key chain. Backend's
#    validateApiKey() is just `SELECT … WHERE key_hash = sha256(plaintext)`.
# ---------------------------------------------------------------------------
RAW_HEX=$(od -An -tx1 -N 24 /dev/urandom | tr -d ' \n')
ORG_KEY="obx_key_${RAW_HEX}"
KEY_HASH=$(printf '%s' "$ORG_KEY" | sha256sum | awk '{print $1}')
KEY_PREFIX=$(printf '%s' "$ORG_KEY" | cut -c1-12)

log "minting org X-API-Key (prefix: ${KEY_PREFIX})"
psql -h "$PG_HOST" -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q -c "
INSERT INTO api_keys (organization_id, name, key_hash, key_prefix, permissions, is_active, created_by)
VALUES (
  '$ORG_REALM',
  'n8n-example-seed',
  '$KEY_HASH',
  '$KEY_PREFIX',
  ARRAY['create:agent','read:agent','update:agent','delete:agent','read:org','read:team','create:team']::text[],
  true,
  'seed:n8n-example'
)
ON CONFLICT (key_hash) DO NOTHING;
" >/dev/null

# ---------------------------------------------------------------------------
# 3. Ensure team exists in BOTH keycloak (queried by backend's team service)
#    and postgres (FK target for agent_teams). Master admin/admin is the
#    documented local-dev keycloak credential — not a password reset, just
#    using the admin API for what it's for.
# ---------------------------------------------------------------------------
log "ensuring team '$TEAM_NAME' exists"
MASTER_TOKEN=$(curl -sf --max-time 10 -X POST \
  "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli&username=$KC_ADMIN_USER&password=$KC_ADMIN_PASS" \
  | jq -r .access_token)
[ -n "$MASTER_TOKEN" ] && [ "$MASTER_TOKEN" != "null" ] || fail "keycloak master login failed"

TEAM_ID=$(curl -sf --max-time 10 \
  "$KEYCLOAK_URL/admin/realms/$ORG_REALM/groups?search=$TEAM_NAME&exact=true" \
  -H "Authorization: Bearer $MASTER_TOKEN" \
  | jq -r '.[0].id // empty')

if [ -z "$TEAM_ID" ]; then
  curl -sf --max-time 10 -X POST \
    "$KEYCLOAK_URL/admin/realms/$ORG_REALM/groups" \
    -H "Authorization: Bearer $MASTER_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$TEAM_NAME\",\"attributes\":{\"description\":[\"Default team for local dev\"],\"icon\":[\"users\"]}}" \
    >/dev/null
  TEAM_ID=$(curl -sf --max-time 10 \
    "$KEYCLOAK_URL/admin/realms/$ORG_REALM/groups?search=$TEAM_NAME&exact=true" \
    -H "Authorization: Bearer $MASTER_TOKEN" \
    | jq -r '.[0].id')
fi
log "team UUID: $TEAM_ID"

psql -h "$PG_HOST" -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q -c "
INSERT INTO teams (id, organization_id, name, description, icon)
VALUES ('$TEAM_ID', '$ORG_REALM', '$TEAM_NAME', 'Default team for local dev', 'users')
ON CONFLICT (id) DO NOTHING;
" >/dev/null

# ---------------------------------------------------------------------------
# 4. Mint the agent. If one with the same name exists, delete first — the
#    create response is the only place the runtime `obx_test_*` surfaces.
# ---------------------------------------------------------------------------
log "checking for existing agent '$AGENT_NAME'"
EXISTING_ID=$(curl -s --max-time 10 "$BACKEND_URL/agent" \
  -H "X-API-Key: $ORG_KEY" \
  -H 'X-Openbox-Client: openbox-cli' \
  | jq -r --arg n "$AGENT_NAME" '.data.results[]? | select(.agent_name==$n) | .id' \
  | head -n 1)

if [ -n "$EXISTING_ID" ] && [ "$EXISTING_ID" != "null" ]; then
  log "deleting existing agent $EXISTING_ID so we can re-mint a fresh runtime key"
  curl -sf --max-time 10 -X DELETE "$BACKEND_URL/agent/$EXISTING_ID" \
    -H "X-API-Key: $ORG_KEY" \
    -H 'X-Openbox-Client: openbox-cli' >/dev/null || true
fi

log "creating agent '$AGENT_NAME' with default AIVSS"
create_agent() {
  name=$1
  curl -s --max-time 30 -X POST "$BACKEND_URL/agent/create" \
    -H "X-API-Key: $ORG_KEY" \
    -H 'X-Openbox-Client: openbox-cli' \
    -H 'Content-Type: application/json' \
    -d "{
      \"agent_name\":\"$name\",
      \"agent_type\":\"chatbot\",
      \"model_name\":\"tinyllama\",
      \"icon\":\"robot\",
      \"description\":\"Example agent governing the n8n integration demo\",
      \"team_ids\":[\"$TEAM_ID\"],
      \"aivss_config\":{
        \"base_security\":{\"attack_vector\":2,\"attack_complexity\":1,\"privileges_required\":2,\"user_interaction\":1,\"scope\":1},
        \"ai_specific\":{\"model_robustness\":3,\"data_sensitivity\":2,\"ethical_impact\":2,\"decision_criticality\":2,\"adaptability\":3},
        \"impact\":{\"confidentiality_impact\":2,\"integrity_impact\":2,\"availability_impact\":2,\"safety_impact\":1}
      }
    }"
}

AGENT_RESP=$(create_agent "$AGENT_NAME")
if echo "$AGENT_RESP" | jq -e '.message? | test("already exists")' >/dev/null 2>&1; then
  AGENT_NAME="${AGENT_NAME}-$(date -u +%Y%m%d%H%M%S)"
  log "agent name already exists; retrying as '$AGENT_NAME'"
  AGENT_RESP=$(create_agent "$AGENT_NAME")
fi

RUNTIME_KEY=$(echo "$AGENT_RESP" | jq -r '.data.token // empty')
[ -n "$RUNTIME_KEY" ] || fail "could not mint agent: $AGENT_RESP"
AGENT_ID=$(echo "$AGENT_RESP" | jq -r '.data.agent.id // .data.id // .data.agent_id // empty')
[ -n "$AGENT_ID" ] || fail "could not read agent id: $AGENT_RESP"

# ---------------------------------------------------------------------------
# 5. Attach visible demo guardrails. The hosted OpenBox agent uses PII, NSFW,
#    draft privacy, and channel-secret policies. The local guardrails shim is
#    intentionally small and only evaluates banned-word rules, so these local
#    rules use deterministic trigger phrases under the same policy names.
#
#    The n8n preset emits:
#    ActivityStarted + activity_type=node-pre-execute + input[].chatInput
#    so Cursor/Claude-style input.*.prompt rules would not match here.
# ---------------------------------------------------------------------------
log "creating demo n8n guardrails on agent $AGENT_ID"
psql -h "$PG_HOST" -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q -c "
DELETE FROM guardrails
WHERE agent_id = '$AGENT_ID'
  AND name IN (
    'Prompt PII Wall',
    'Prompt NSFW Wall',
    'Draft Privacy Check',
    'Channel Secret Check',
    'Block demo trigger'
  );

INSERT INTO guardrails (
  agent_id,
  guardrail_type,
  name,
  description,
  processing_stage,
  is_active,
  \"order\",
  params,
  settings,
  trust_impact
) VALUES
(
  '$AGENT_ID',
  '4',
  'Prompt PII Wall',
  'Local deterministic mirror of the hosted prompt PII wall for card, SSN, password, API key, and token prompts.',
  '0',
  true,
  0,
  '{\"banned_words\":[\"4242 4242\",\"123-45-6789\",\"ssn\",\"card 4242\",\"password\",\"api key\",\"token\"]}'::jsonb,
  '{\"on_fail\":1,\"timeout\":5000,\"log_violation\":true,\"retry_attempts\":0,\"activities\":[{\"activity_type\":\"node-pre-execute\",\"fields_to_check\":[\"input.*.chatInput\"]}]}'::jsonb,
  'high'
),
(
  '$AGENT_ID',
  '4',
  'Prompt NSFW Wall',
  'Local deterministic mirror of the hosted prompt NSFW wall.',
  '0',
  true,
  1,
  '{\"banned_words\":[\"nsfw\",\"abuse-demo\",\"violent sexual\"]}'::jsonb,
  '{\"on_fail\":1,\"timeout\":5000,\"log_violation\":true,\"retry_attempts\":0,\"activities\":[{\"activity_type\":\"node-pre-execute\",\"fields_to_check\":[\"input.*.chatInput\"]}]}'::jsonb,
  'high'
),
(
  '$AGENT_ID',
  '4',
  'Draft Privacy Check',
  'Local deterministic mirror of the hosted draft privacy check.',
  '0',
  true,
  2,
  '{\"banned_words\":[\"contextblock\",\"blockme\"]}'::jsonb,
  '{\"on_fail\":1,\"timeout\":5000,\"log_violation\":true,\"retry_attempts\":0,\"activities\":[{\"activity_type\":\"node-pre-execute\",\"fields_to_check\":[\"input.*.chatInput\"]}]}'::jsonb,
  'high'
),
(
  '$AGENT_ID',
  '4',
  'Channel Secret Check',
  'Local deterministic mirror of the hosted outbound secret check for provider keys, Slack tokens, and password-like strings.',
  '0',
  true,
  3,
  '{\"banned_words\":[\"channelblock\",\"sk-\",\"xoxb-\",\"slack token\",\"password:\"]}'::jsonb,
  '{\"on_fail\":1,\"timeout\":5000,\"log_violation\":true,\"retry_attempts\":0,\"activities\":[{\"activity_type\":\"node-pre-execute\",\"fields_to_check\":[\"input.*.chatInput\"]}]}'::jsonb,
  'high'
),
(
  '$AGENT_ID',
  '4',
  'Block demo trigger',
  'Backwards-compatible local tripwire for older demo scripts.',
  '0',
  true,
  4,
  '{\"banned_words\":[\"openbox-block-demo\"]}'::jsonb,
  '{\"on_fail\":1,\"timeout\":5000,\"log_violation\":true,\"retry_attempts\":0,\"activities\":[{\"activity_type\":\"node-pre-execute\",\"fields_to_check\":[\"input.*.chatInput\"]}]}'::jsonb,
  'medium'
);
" >/dev/null

# ---------------------------------------------------------------------------
# 6. Persist for n8n.
# ---------------------------------------------------------------------------
mkdir -p "$(dirname "$KEY_FILE")"
printf '%s' "$RUNTIME_KEY" > "$KEY_FILE"
chmod 644 "$KEY_FILE"
log "wrote agent runtime key to $KEY_FILE (prefix: $(printf '%s' "$RUNTIME_KEY" | cut -c1-14))"
log "done"
