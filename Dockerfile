# Đóng gói web app credit_checker cùng music-audit, yt-dlp và ffmpeg. Khóa không nằm trong image, xem compose.yml.

FROM node:24-slim AS build
WORKDIR /app/tool/credit_checker
COPY tool/credit_checker/package.json tool/credit_checker/package-lock.json ./
RUN npm ci
COPY tool/credit_checker/ ./
RUN npm run build

FROM node:24-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*
# yt-dlp hay hỏng khi YouTube thay đổi, nên build lại image với --no-cache để lấy bản mới.
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir "yt-dlp[default]"

WORKDIR /app
COPY audit.py ./
COPY music_audit ./music_audit
COPY tool/credit_checker/package.json ./tool/credit_checker/
COPY tool/credit_checker/server ./tool/credit_checker/server
COPY tool/credit_checker/src/youtubeLink.ts tool/credit_checker/src/uploadLimit.ts ./tool/credit_checker/src/
COPY --from=build /app/tool/credit_checker/dist ./tool/credit_checker/dist
RUN mkdir /data && chown node:node /data

ENV HOST=0.0.0.0 \
    PORT=8080 \
    MUSIC_AUDIT_ROOT=/app \
    MUSIC_AUDIT_WORKDIR=/data \
    MUSIC_AUDIT_PYTHON=/opt/venv/bin/python \
    FFMPEG_LOCATION=/usr/bin/ffmpeg \
    PYTHONDONTWRITEBYTECODE=1

USER node
WORKDIR /app/tool/credit_checker
EXPOSE 8080
CMD ["node", "server/productionServer.ts"]
