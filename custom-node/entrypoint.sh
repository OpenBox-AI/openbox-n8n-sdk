#!/bin/sh
set -e

# Copy the prebuilt custom node into the n8n data volume on first start.
# The volume is mounted at /home/node/.n8n which shadows anything baked
# into the image at that path; staging in /opt and copying once is the
# simplest portable approach.
DEST="/home/node/.n8n/custom/n8n-nodes-openbox-hook"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R -P /opt/custom-nodes/n8n-nodes-openbox-hook/. "$DEST/"

# If the seed service provisioned an agent runtime key, surface it as
# OPENBOX_API_KEY so the workflow picks it up without the user touching
# .env. Anything already in the env wins.
if [ -z "${OPENBOX_API_KEY:-}" ] && [ -f /seed/agent_key ] && [ -s /seed/agent_key ]; then
  OPENBOX_API_KEY=$(cat /seed/agent_key)
  export OPENBOX_API_KEY
fi

exec n8n "$@"
