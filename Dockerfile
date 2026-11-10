# Đóng gói web app cùng music-audit, yt-dlp và ffmpeg. Khóa không nằm trong image, xem compose.yml.

FROM node:24-slim AS build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:24-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*
# yt-dlp hay hỏng khi YouTube thay đổi, nên build lại image với --no-cache để lấy bản mới.
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir "yt-dlp[default]"
# Công cụ của AudD để tab Theo dõi hạn mức đọc gói và số yêu cầu. Cài hỏng thì app vẫn chạy, tab sẽ báo thiếu công cụ.
RUN /opt/venv/bin/pip install --no-cache-dir audd-cli==0.1.4 || echo "Không cài được audd-cli"

WORKDIR /app
# Máy lọc nhạc cho tab Quét cả kênh. Cài hỏng thì app vẫn chạy, tab sẽ báo thiếu mô hình và vẫn quét được khi tắt lọc.
COPY requirements-detect.txt ./
RUN /opt/venv/bin/pip install --no-cache-dir -r requirements-detect.txt || echo "Không cài được thư viện lọc nhạc"
RUN mkdir models && /opt/venv/bin/python -c "import urllib.request as u; u.urlretrieve('https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/latest/yamnet.tflite', 'models/yamnet.tflite'); u.urlretrieve('https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv', 'models/yamnet_class_map.csv')" || echo "Không tải được mô hình lọc nhạc"
COPY audit.py ./
COPY music_audit ./music_audit
COPY resources ./resources
COPY web/package.json ./web/
COPY web/server ./web/server
COPY web/src/youtubeLink.ts web/src/uploadLimit.ts web/src/batchScan.ts web/src/channelScan.ts web/src/history.ts ./web/src/
COPY --from=build /app/web/dist ./web/dist
RUN mkdir /data && chown node:node /data

ENV HOST=0.0.0.0 \
    PORT=8080 \
    MUSIC_AUDIT_ROOT=/app \
    MUSIC_AUDIT_WORKDIR=/data \
    MUSIC_AUDIT_PYTHON=/opt/venv/bin/python \
    FFMPEG_LOCATION=/usr/bin/ffmpeg \
    PYTHONDONTWRITEBYTECODE=1 \
    AUDD_CLI=/opt/venv/bin/audd \
    AUDD_CONFIG_DIR=/data/audd/config \
    AUDD_CACHE_DIR=/data/audd/cache \
    AUDD_DATA_DIR=/data/audd/data

USER node
WORKDIR /app/web
EXPOSE 8080
CMD ["node", "server/productionServer.ts"]
