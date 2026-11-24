# ClipGen AI backend — one image with Node, FFmpeg, whisper.cpp (speech-to-text) and OpenCV (face tracking).
#
# Works two ways:
#   • Any Docker host with only this file:                 builds from the public GitHub repo (SOURCE=git, default)
#   • Local build from a checkout (repo root as context):  docker build -f backend/Dockerfile --build-arg SOURCE=local .
#     (this is what backend/deploy/oracle/bootstrap.sh does on the Oracle VM)
#
# Build arguments: WHISPER_MODEL (tiny|base|small, default base) · WHISPER_NATIVE (ON|OFF, default OFF, see below)
#
# NOTE: this file has not been built inside the development sandbox (no Docker there). See backend/DEPLOY.md.

ARG SOURCE=git

# ---------- 1. where the project files come from ----------
FROM alpine/git AS src-git
ARG REPO=https://github.com/Akshxt10/clipgen-ai.git
ARG REF=main
RUN git clone --depth 1 --branch "$REF" "$REPO" /out

FROM scratch AS src-local
COPY . /out

FROM src-${SOURCE} AS src

# ---------- 2. build whisper.cpp and fetch a speech model ----------
FROM debian:bookworm-slim AS whisper
ARG WHISPER_REF=v1.7.5
ARG WHISPER_MODEL=base
# GGML_NATIVE=OFF builds for a generic CPU of the same architecture (aarch64 / x86-64) instead of the build machine's exact CPU.
# That avoids "illegal instruction" crashes if the image is built on one machine and run on another (the usual case on
# managed hosts, and on Arm). The cost is somewhat slower speech recognition than a native build; use
# --build-arg WHISPER_NATIVE=ON only when you build on the very machine that will run the image.
ARG WHISPER_NATIVE=OFF
RUN apt-get update && apt-get install -y --no-install-recommends git cmake g++ make curl wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$WHISPER_REF" https://github.com/ggml-org/whisper.cpp /w
WORKDIR /w
RUN cmake -B build -DBUILD_SHARED_LIBS=OFF -DGGML_OPENMP=OFF -DGGML_NATIVE=${WHISPER_NATIVE} -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j2 --config Release --target whisper-cli
RUN sh ./models/download-ggml-model.sh "$WHISPER_MODEL" \
    && mkdir -p /models && mv "models/ggml-${WHISPER_MODEL}.bin" /models/model.bin \
    && cp build/bin/whisper-cli /usr/local/bin/whisper-cli

# ---------- 3. runtime ----------
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-opencv fontconfig fonts-dejavu-core fonts-liberation \
    && for f in fonts-inter fonts-montserrat fonts-open-sans fonts-lato fonts-roboto fonts-noto-core; do apt-get install -y --no-install-recommends "$f" || true; done \
    && fc-cache -f && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /models/model.bin /models/model.bin
COPY --from=src /out/backend /app/backend
COPY --from=src /out/phase2 /app/phase2
RUN mkdir -p /data && chown -R node:node /data /app
USER node
WORKDIR /app/backend
ENV NODE_ENV=production \
    PORT=7860 \
    DATA_DIR=/data \
    FRONTEND_DIR=/app/phase2 \
    WHISPER_BIN=/usr/local/bin/whisper-cli \
    WHISPER_MODEL_PATH=/models/model.bin
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7860)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
