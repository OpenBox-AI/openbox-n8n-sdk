#!/bin/sh
set -eu

: "${PGHOST:=openbox-postgres}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGPASSWORD:=password}"
: "${PGDATABASE:=openbox}"
export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE

log() { echo "[guardrails-shim] $*" >&2; }

json_response() {
  status="$1"
  body="$2"
  bytes=$(printf '%s' "$body" | wc -c | tr -d ' ')
  {
    printf 'HTTP/1.1 %s\r\n' "$status"
    printf 'Content-Type: application/json\r\n'
    printf 'Content-Length: %s\r\n' "$bytes"
    printf 'Connection: close\r\n'
    printf '\r\n'
    printf '%s' "$body"
  }
}

evaluate() {
  body_file="$1"
  psql -qAt -v ON_ERROR_STOP=1 -v body="$(cat "$body_file")" <<'SQL'
WITH req AS (
  SELECT :'body'::jsonb AS body
),
agent AS (
  SELECT a.id, (SELECT body->'logs' FROM req) AS logs, (SELECT body->>'token' FROM req) AS token
  FROM agents a, req
  WHERE a.token = req.body->>'token'
  LIMIT 1
),
active_guardrails AS (
  SELECT
    g.id,
    g.guardrail_type,
    g.params,
    g.settings,
    g."order",
    a.logs
  FROM guardrails g
  JOIN agent a ON a.id = g.agent_id
  WHERE g.is_active = true
    AND g.guardrail_type = '4'
    AND g.processing_stage = '0'
    AND a.logs->>'event_type' = 'ActivityStarted'
  ORDER BY g."order" ASC
),
fields AS (
  SELECT
    g.id,
    g.guardrail_type,
    g.params,
    g."order",
    field.value AS field
  FROM active_guardrails g
  CROSS JOIN LATERAL jsonb_array_elements(g.settings->'activities') activity(value)
  CROSS JOIN LATERAL jsonb_array_elements_text(activity.value->'fields_to_check') field(value)
  WHERE activity.value->>'activity_type' = g.logs->>'activity_type'
    AND field.value IN ('input.*.chatInput')
),
values AS (
  SELECT
    f.id,
    f.guardrail_type,
    f.params,
    f."order",
    f.field,
    jsonb_path_query_array(
      (SELECT logs FROM agent),
      CASE f.field
        WHEN 'input.*.chatInput' THEN '$.input[*].chatInput'::jsonpath
        ELSE '$.input[*].chatInput'::jsonpath
      END
    ) AS raw_values
  FROM fields f
),
flat_values AS (
  SELECT
    v.id,
    v.guardrail_type,
    v.params,
    v."order",
    v.field,
    lower(raw.value #>> '{}') AS text_value
  FROM values v
  CROSS JOIN LATERAL jsonb_array_elements(v.raw_values) raw(value)
),
hits AS (
  SELECT
    fv.id,
    fv.guardrail_type,
    fv."order",
    fv.field,
    word.value AS banned_word
  FROM flat_values fv
  CROSS JOIN LATERAL jsonb_array_elements_text(fv.params->'banned_words') word(value)
  WHERE fv.text_value LIKE '%' || lower(word.value) || '%'
),
grouped AS (
  SELECT
    guardrail_type,
    jsonb_agg(
      jsonb_build_object(
        'field', field,
        'order', "order",
        'status', 'block',
        'reason', 'Matched banned word: ' || banned_word
      )
      ORDER BY "order"
    ) AS results
  FROM hits
  GROUP BY guardrail_type
),
response AS (
  SELECT jsonb_build_object(
    'token', COALESCE((SELECT token FROM agent), (SELECT body->>'token' FROM req)),
    'raw_logs', (SELECT body->'logs' FROM req),
    'validated_logs', (SELECT body->'logs' FROM req),
    'guardrail_results', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object('guardrail_type', guardrail_type, 'results', results)) FROM grouped),
      '[]'::jsonb
    ),
    'action', CASE WHEN EXISTS (SELECT 1 FROM hits) THEN 'stop' ELSE 'continue' END
  ) AS payload
)
SELECT payload::text FROM response;
SQL
}

handle_request() {
  body_file=$(mktemp)
  request_line=''
  content_length=0

  IFS= read -r request_line || true
  request_line=$(printf '%s' "$request_line" | tr -d '\r')

  while IFS= read -r line; do
    clean=$(printf '%s' "$line" | tr -d '\r')
    [ -z "$clean" ] && break
    case "$(printf '%s' "$clean" | tr '[:upper:]' '[:lower:]')" in
      content-length:*)
        content_length=$(printf '%s' "$clean" | awk -F: '{gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2}')
        ;;
    esac
  done

  if [ "${content_length:-0}" -gt 0 ]; then
    dd bs=1 count="$content_length" of="$body_file" 2>/dev/null
  else
    : > "$body_file"
  fi

  if printf '%s' "$request_line" | grep -q 'POST /api/v1/guardrails/evaluate '; then
    if payload=$(evaluate "$body_file" 2>&1); then
      json_response "200 OK" "$payload"
    else
      log "$payload"
      json_response "500 Internal Server Error" '{"detail":"guardrails shim evaluation failed"}'
    fi
  else
    json_response "404 Not Found" '{"detail":"not found"}'
  fi

  rm -f "$body_file"
}

if [ "${1:-}" = "handle" ]; then
  handle_request
  exit 0
fi

log "listening on :8000"
exec nc -lk -p 8000 -e /usr/local/bin/guardrails-shim handle
