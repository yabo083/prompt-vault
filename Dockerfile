FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/cli/package.json packages/cli/package.json
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8767 \
    PROMPT_VAULT_WORKSPACE=/data/workspace \
    PROMPT_VAULT_TOKEN_FILE=/data/.vault-token \
    PROMPT_VAULT_CREDENTIAL_DIRECTORY=/data/.vault-auth \
    PROMPT_VAULT_STATIC_DIRECTORY=/app/static/dist

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/static/dist ./static/dist
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8767
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8767/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server/index.js"]
