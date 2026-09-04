# EquiStar — the hub, the app, and the Python engines in one image.
#
# ONE IMAGE, MANY PROCESSES. The container runs the hub; the hub starts one app process per
# participant. They share this filesystem and differ only in the environment they are given —
# their own port, their own database file, their own data directory. That is the whole isolation
# model, and it needs no cooperation from the app code.
#
# PYTHON IS NOT OPTIONAL. Six services shell out to the scanner and scorer scripts in engines/.
# Without python3 and its packages the Top 25, Portfolio Health and Stock Sleuth all go quiet —
# and quietly, because execFile fails with ENOENT rather than anything a user would understand.

# ── build: the React client ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS client

WORKDIR /build
COPY app/client/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY app/client ./
RUN npm run build

# ── build: native modules ────────────────────────────────────────────────────
# sqlite3 compiles from source when no prebuilt binary matches. That needs python3, make and g++
# — about 300MB of toolchain with no business in the running image.
FROM node:22-bookworm-slim AS deps

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /deps/hub
COPY hub/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

WORKDIR /deps/app/server
COPY app/server/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# ca-certificates: Yahoo and NSE are reached over TLS and every request fails verification
# without the bundle. wget is the healthcheck. python3 runs the engines.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates wget python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=5080 \
    DATA_DIR=/data \
    ENGINES_DIR=/app/engines \
    INSTANCE_PORT_BASE=5100 \
    INSTANCE_PORT_MAX=5199 \
    TZ=Asia/Kolkata

WORKDIR /app

# A virtualenv rather than pip --user or --break-system-packages: Debian marks its Python as
# externally managed, and pip refuses to install into it. config/engines.js looks for venv/bin
# before falling back to PATH, so this is found automatically.
COPY engines/requirements.txt* /app/engines/
RUN python3 -m venv /app/engines/venv \
 && /app/engines/venv/bin/pip install --no-cache-dir --upgrade pip \
 && if [ -f /app/engines/requirements.txt ]; then \
      /app/engines/venv/bin/pip install --no-cache-dir -r /app/engines/requirements.txt; \
    else \
      /app/engines/venv/bin/pip install --no-cache-dir yfinance pandas numpy requests arch; \
    fi

COPY --from=deps /deps/hub/node_modules ./hub/node_modules
COPY --from=deps /deps/app/server/node_modules ./app/server/node_modules
COPY --from=client /build/dist ./app/client/dist

COPY hub ./hub
COPY app/server ./app/server
COPY app/scripts ./app/scripts
COPY engines ./engines

# Run as the unprivileged `node` user the base image provides. /data is created and chowned here
# because Docker copies the image's ownership into an empty named volume on first mount, and
# nowhere else establishes it.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 5080

# Hits the hub's sign-in page, which touches neither the database nor any upstream feed — a probe
# that failed when Yahoo was down would restart a perfectly healthy container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5080/hub/ >/dev/null || exit 1

CMD ["node", "hub/src/server.js"]
