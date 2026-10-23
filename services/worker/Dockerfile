# syntax=docker/dockerfile:1
#
# worker service. Build from the repository root, because the workspace packages are shared:
#   docker build --file services/worker/Dockerfile --tag libredi/worker .

FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS build
WORKDIR /repo
# Node.js 26 no longer ships Corepack: install the pnpm version pinned in package.json.
RUN npm install --global pnpm@12.15.0

# Dependencies first, so that a source change does not reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/service-kit/package.json packages/service-kit/
COPY services/worker/package.json services/worker/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @libredi/worker...

COPY tsconfig.base.json ./
COPY packages/service-kit packages/service-kit
COPY services/worker services/worker
RUN pnpm --filter @libredi/worker build

FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS runtime
LABEL org.opencontainers.image.title="libredi-worker" \
      org.opencontainers.image.description="Libredi worker service" \
      org.opencontainers.image.source="https://github.com/imapanda/libredi" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /repo/services/worker/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "dist/main.js", "healthcheck"]
CMD ["node", "--enable-source-maps", "dist/main.js"]
