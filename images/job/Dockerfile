# The fabrica/job image: one container per job in Docker runner mode (apps/runner/src/docker.ts).
# Build it from the repo root with: docker build -t fabrica/job images/job
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm through corepack, fetched at build time into a directory every uid can read.
ENV COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm && corepack install --global pnpm@12.11.2 && pnpm --version && chmod -R a+rX /opt/corepack

# The Agent SDK at the version pnpm-lock.yaml resolves, next to the entry script that runs one query() per exec.
WORKDIR /opt/fabrica
RUN npm install --no-fund --no-audit --save-exact @anthropic-ai/claude-agent-sdk@0.3.296
COPY agent.mjs /opt/fabrica/agent.mjs

# Containers run as the host user, which has no home in the image: the SDK keeps its session files here.
RUN mkdir -m 1777 /home/fabrica
ENV HOME=/home/fabrica

CMD ["sleep", "infinity"]
