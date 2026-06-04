FROM node:20-alpine AS builder
WORKDIR /work/example/n8n/custom-node

COPY example/n8n/custom-node/package.json ./
RUN npm install --no-audit --no-fund
COPY example/n8n/custom-node ./
RUN npm run build && npm prune --omit=dev --omit=optional

# ---------------------------------------------------------------------------

FROM n8nio/n8n:latest
USER root

RUN mkdir -p /opt/custom-nodes/n8n-nodes-openbox-hook
COPY --from=builder /work/example/n8n/custom-node/package.json /opt/custom-nodes/n8n-nodes-openbox-hook/
COPY --from=builder /work/example/n8n/custom-node/dist /opt/custom-nodes/n8n-nodes-openbox-hook/dist

COPY example/n8n/custom-node/entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

USER node
ENTRYPOINT ["/opt/entrypoint.sh"]
