# --- Lightweight, multi-stage build for Raspberry Pi / VPS -----------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
# package-lock.json is optional; using npm install for a clean install.
RUN npm install --omit=dev --no-audit --no-fund

FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

# Drop privileges
RUN addgroup -S kindbot && adduser -S kindbot -G kindbot

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

USER kindbot
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1

CMD ["node", "src/server.js"]
