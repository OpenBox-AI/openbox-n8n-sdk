FROM node:20-alpine AS builder
WORKDIR /work

# Prebuilt openbox-sdk from the parent repo. The example package depends on
# `openbox-sdk` via `file:../../..`, so the Docker context must be the repo root.
COPY package.json ./package.json
COPY dist ./dist
RUN npm pkg delete scripts.prepare scripts.prepublishOnly

COPY example/n8n/custom-node ./example/n8n/custom-node

WORKDIR /work/example/n8n/custom-node
RUN npm install --no-audit --no-fund --omit=optional \
 && npm run build \
 && npm run smoke:load \
 && npm prune --omit=dev --omit=optional \
 && npm pkg delete dependencies.openbox-sdk devDependencies scripts \
 && npm install --no-audit --no-fund --omit=dev --omit=optional --no-save --install-links ../../.. \
 && node -e "import('openbox-sdk').then(() => console.log('sdk-import-ok'))"

# ---------------------------------------------------------------------------

FROM n8nio/n8n:latest
USER root

# Stage the compiled node + its runtime deps in /opt; the entrypoint
# copies it into the n8n data volume on first start so the volume mount at
# /home/node/.n8n does not shadow the install.
RUN mkdir -p /opt/custom-nodes/n8n-nodes-openbox-hook
COPY --from=builder /work/example/n8n/custom-node/package.json /opt/custom-nodes/n8n-nodes-openbox-hook/
COPY --from=builder /work/example/n8n/custom-node/dist /opt/custom-nodes/n8n-nodes-openbox-hook/dist
COPY --from=builder /work/example/n8n/custom-node/node_modules /opt/openbox-runtime/node_modules
RUN mkdir -p /opt/custom-nodes/n8n-nodes-openbox-hook/node_modules \
 && ln -s /opt/openbox-runtime/node_modules/openbox-sdk /opt/custom-nodes/n8n-nodes-openbox-hook/node_modules/openbox-sdk

COPY example/n8n/custom-node/entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

USER node
ENTRYPOINT ["/opt/entrypoint.sh"]
