FROM node:22-slim

  # Install system dependencies for Playwright
  RUN apt-get update && apt-get install -y \
      libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
      libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
      libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libpangocairo-1.0-0 \
      libcairo2 libxcb1 libxcb-shm0 libxcursor1 libxi6 libxext6 \
      libxss1 libxtst6 fonts-liberation libappindicator3-1 \
      libc6 ca-certificates fonts-noto-cjk \
      && rm -rf /var/lib/apt/lists/*

  WORKDIR /app

  # Install pnpm
  RUN npm install -g pnpm

  # Copy all source
  COPY . .

  # Install packages — no frozen-lockfile so pnpm picks the correct linux-x64-gnu native binaries
  # (CI=true causes frozen-lockfile by default which fails for cross-platform native packages)
  RUN pnpm install --no-frozen-lockfile

  # Build the React frontend
  RUN cd artifacts/petrotrade-scraper && pnpm run build

  # Build the API server
  RUN pnpm --filter @workspace/api-server run build

  WORKDIR /app/artifacts/api-server

  EXPOSE 8080

  CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
  