# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Base images are pinned by digest (tag kept for readability); Dependabot bumps them.
# The build stage runs on the builder's own platform: .output is plain JavaScript, so one
# build serves amd64 and arm64 images without emulating the other architecture.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/patch-dependencies.mjs ./scripts/patch-dependencies.mjs
# The build needs no dependency install scripts: onnxruntime-node's downloads ~340 MB
# of CUDA libraries and sharp's checks a binary; the server loads neither. Only the
# project's own patch runs.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund && node scripts/patch-dependencies.mjs
COPY . .
# SITE_URL: public origin for canonical/og URLs and the sitemap (empty = left out).
# GITHUB_SHA: the commit /version.json reports (the build context has no .git).
# VITE_MODEL_HOST: model mirror (Hugging Face layout); empty = huggingface.co.
ARG SITE_URL=""
ARG GITHUB_SHA=""
ARG VITE_MODEL_HOST=""
# VITE_SITE_OPERATOR / VITE_SITE_CONTACT: who runs this copy and a private contact, named
# on the Privacy and Terms pages (empty = nobody named).
ARG VITE_SITE_OPERATOR=""
ARG VITE_SITE_CONTACT=""
# Vite emits different code for an empty env variable and an absent one. Match a
# plain npm build when optional operator details are omitted.
RUN if [ -z "$VITE_SITE_OPERATOR" ]; then unset VITE_SITE_OPERATOR; fi; \
    if [ -z "$VITE_SITE_CONTACT" ]; then unset VITE_SITE_CONTACT; fi; \
    npm run build

# .output is plain JavaScript (no native modules), so the runtime needs no glibc.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
# Heap cap below the 256 MB container limit, so V8 collects garbage before the
# kernel OOM-kills the process.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 NODE_OPTIONS=--max-old-space-size=192
WORKDIR /app
# Owned by root: the node user can read the app but not modify it.
COPY --from=build /app/.output ./.output
USER node
EXPOSE 3000
# BusyBox wget: the probe costs a tiny process instead of a second Node runtime.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", ".output/server/index.mjs"]
