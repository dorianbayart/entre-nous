# Entre Nous relay: Node + Redis (RAM) in a single container, and the PWA it serves.

FROM node:lts-alpine AS web
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:lts-alpine
RUN apk add --no-cache redis tini \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY relay/package.json relay/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY relay/src ./src
COPY --from=web /build/dist ./public
# Apps offered on the landing page (built beforehand into downloads/; may be empty)
COPY downloads/ ./public/download/
USER node
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
