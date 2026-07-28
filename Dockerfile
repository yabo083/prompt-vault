FROM node:24-alpine AS runtime

ARG PROMPT_VAULT_VERSION=dev
ARG PROMPT_VAULT_TARBALL_SHA256=unknown
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="Prompt Vault" \
      org.opencontainers.image.version=$PROMPT_VAULT_VERSION \
      org.opencontainers.image.revision=$VCS_REF \
      dev.prompt-vault.tarball-sha256=$PROMPT_VAULT_TARBALL_SHA256

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8767 \
    PROMPT_VAULT_WORKSPACE=/data/workspace \
    PROMPT_VAULT_TOKEN_FILE=/data/.vault-token \
    PROMPT_VAULT_CREDENTIAL_DIRECTORY=/data/.vault-auth \
    PROMPT_VAULT_BROWSER_SESSION_DIRECTORY=/data/.browser-sessions

COPY artifacts/prompt-vault.tgz /tmp/prompt-vault.tgz
RUN npm install --global /tmp/prompt-vault.tgz && rm /tmp/prompt-vault.tgz
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8767
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8767/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "/usr/local/lib/node_modules/@miyako-lab/prompt-vault-cli/dist/server/index.js"]
