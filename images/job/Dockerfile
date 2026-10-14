# The fabrica/job image: one container per job in Docker runner mode (apps/runner/src/docker.ts).
# Build it from the repo root with: docker build -t fabrica/job images/job
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Debian's Chromium at a pinned version, from a snapshot.debian.org source so the version stays fetchable after newer security updates.
RUN echo "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20261014T000000Z bookworm-security main" > /etc/apt/sources.list.d/snapshot-security.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends chromium=155.0.8059.39-1~deb12u1 chromium-common=155.0.8059.39-1~deb12u1 fonts-liberation fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/* \
  && chmod -R a+rX /usr/lib/chromium

# pnpm through corepack, fetched at build time into a directory every uid can read.
ENV COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm && corepack install --global pnpm@12.11.2 && pnpm --version && chmod -R a+rX /opt/corepack

# The agent-browser CLI, installed globally so it is on every uid's PATH.
RUN npm install --global --no-fund --no-audit agent-browser@0.39.1 && agent-browser --version

# agent-browser drives the Chromium above; its sandbox is off because containers run as a uid without the capabilities it needs (the container is the boundary).
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium AGENT_BROWSER_ARGS=--no-sandbox,--disable-dev-shm-usage

# The Agent SDK at the version pnpm-lock.yaml resolves, next to the entry script that runs one query() per exec.
WORKDIR /opt/fabrica
RUN npm install --no-fund --no-audit --save-exact @anthropic-ai/claude-agent-sdk@0.3.296
COPY agent.mjs /opt/fabrica/agent.mjs

# Containers run as the host user, which has no home in the image: the SDK keeps its session files here.
RUN mkdir -m 1777 /home/fabrica
ENV HOME=/home/fabrica

CMD ["sleep", "infinity"]
