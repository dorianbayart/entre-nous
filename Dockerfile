# Entre Nous relay: Node + Redis (RAM) in a single container, and the PWA it serves.

FROM node:lts-alpine AS web
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
COPY docs/images/chiffrement.svg docs/images/reseau.svg docs/images/chiffrement-en.svg docs/images/reseau-en.svg /docs/images/
# the changelog: what's new in the apps, the site's "What's new" pages
COPY CHANGELOG.md CHANGELOG.en.md /
COPY scripts/changelog.mjs /scripts/
# the release built (0.1.42), given by scripts/auto-update.sh: no git history in the image
ARG APP_VERSION=
RUN npm run build

FROM node:lts-alpine
RUN apk add --no-cache redis tini \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY relay/package.json relay/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY relay/src ./src
COPY --from=web /build/dist ./public
# shown in the apps' settings (none: a relay built by hand)
ARG APP_VERSION=
ENV APP_VERSION=$APP_VERSION
USER node
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
