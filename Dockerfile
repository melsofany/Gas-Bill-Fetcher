FROM node:22-slim

# Install system dependencies + Chromium browser via apt
# Full set of libs required by Chromium headless on Debian slim
RUN apt-get update && apt-get install -y \
    chromium \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libpangocairo-1.0-0 \
    libcairo2 libxcb1 libxcb-shm0 libxcursor1 libxi6 libxext6 \
    libxss1 libxtst6 fonts-liberation libappindicator3-1 \
    libc6 ca-certificates fonts-noto-cjk \
    libglib2.0-0 libx11-6 libx11-xcb1 libxcb-dri3-0 libexpat1 \
    zip \
    && rm -rf /var/lib/apt/lists/*

# Tell Playwright NOT to download its own Chromium binary
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Explicitly point Playwright at the system Chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

RUN npm install -g pnpm

COPY . .

# Build browser extension zip (served at /dl/browser-agent.zip)
RUN mkdir -p artifacts/api-server/public && \
    cd scripts/browser-agent && \
    zip -r /app/artifacts/api-server/public/browser-agent.zip .

RUN pnpm install --ignore-scripts

RUN node node_modules/.pnpm/esbuild@0.27.3/node_modules/esbuild/install.js

RUN cd artifacts/petrotrade-scraper && pnpm run build

RUN pnpm --filter @workspace/api-server run build

WORKDIR /app/artifacts/api-server

EXPOSE 8080

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
