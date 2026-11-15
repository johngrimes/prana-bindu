# syntax=docker/dockerfile:1

# ---- build: compile native deps, the SPA (vite) and the server (tsc) ----
FROM node:22-slim AS build
WORKDIR /app
# Toolchain for better-sqlite3 when no prebuilt binary matches the Node version.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime: production dependencies + build output only ----
FROM node:22-slim AS runtime
LABEL org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    PRANA_DATA_DIR=/data \
    PRANA_PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
COPY LICENSE NOTICE ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
RUN mkdir -p /data && chown node:node /data \
 && printf '#!/bin/sh\nexec node /app/dist/server/cli/main.js "$@"\n' > /usr/local/bin/prana-bindu \
 && chmod 755 /usr/local/bin/prana-bindu
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PRANA_PORT||3000)+'/api/v1/openapi.json').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "dist/server/cli/main.js"]
CMD ["serve"]
