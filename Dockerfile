# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json tsconfig.json ./
RUN YOUTUBE_DL_SKIP_DOWNLOAD=1 npm ci

COPY src/ ./src/
RUN npm run build

# Runtime stage
FROM node:22-alpine

WORKDIR /app

# Cài đặt Python3, FFmpeg và curl cho Koyeb runtime
RUN apk add --no-cache python3 ffmpeg curl

# Tải bản yt-dlp binary mới nhất
RUN curl -fL --retry 3 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

COPY package*.json ./
RUN YOUTUBE_DL_SKIP_DOWNLOAD=1 npm ci --omit=dev

COPY --from=builder /app/dist ./dist

ENV PORT=8000
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
EXPOSE 8000

CMD ["node", "dist/server.js"]
