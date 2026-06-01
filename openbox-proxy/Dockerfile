FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

# No external runtime deps (uses only Node built-ins). Skip
# `npm install` to keep the image minimal; the package.json is
# present only for engine constraints + scripts.

USER node
EXPOSE 8888
ENV PROXY_PORT=8888

CMD ["node", "src/server.js"]
