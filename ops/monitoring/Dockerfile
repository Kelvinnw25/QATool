# syntax=docker/dockerfile:1
#
# The QATOOL ops monitor as a container (compose.yaml, service qatool-monitoring).
# Build context: ops/monitoring/ only (not the repository root), filtered by the .dockerignore beside this file.
#
# No dependencies are installed: the monitor uses only Node's built-ins, so there is no `npm ci`, no
# package-lock, and nothing to audit in the image beyond the base. Nothing in it is a secret: no .env, no
# token, no Docker CLI. Settings arrive as plain environment variables from compose.yaml.

ARG NODE_VERSION=22.15.0
FROM node:${NODE_VERSION}-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# The application files stay owned by root and are not writable by the user the service runs as.
COPY package.json server.js ./
COPY src ./src
COPY public ./public

# The same user (uid 1000) the QATOOL backend runs as. The backend's metrics socket is created 0600 by
# that user, and only that user can connect to it.
USER node

# Run on its own, this image binds to the loopback of its own container and reads nothing: container mode is
# switched on by compose.yaml, explicitly. 3300 is the port inside the container; the host port is Compose's.
EXPOSE 3300

# The monitor's own liveness (it says nothing about the system it watches). Node's built-in fetch only.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3300/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server.js"]
