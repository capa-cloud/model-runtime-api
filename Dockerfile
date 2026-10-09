# syntax=docker/dockerfile:1
FROM node:22.22.0-alpine AS build
ENV CI=true
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json biome.json vitest.config.ts ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && pnpm --filter @model-runtime/server deploy --prod --legacy /out

FROM build AS verification
RUN apk add --no-cache git

FROM node:22.22.0-alpine AS runtime
ENV NODE_ENV=production \
    MODEL_RUNTIME_HOST=127.0.0.1 \
    MODEL_RUNTIME_PORT=4320
WORKDIR /app
RUN addgroup -S runtime && adduser -S runtime -G runtime
RUN mkdir -p /var/lib/model-runtime \
  && chown runtime:runtime /var/lib/model-runtime \
  && chmod 700 /var/lib/model-runtime
COPY --from=build --chown=runtime:runtime /out ./
USER runtime
EXPOSE 4320
HEALTHCHECK --interval=10s --timeout=2s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4320/v1/runtime').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/cli.js"]
