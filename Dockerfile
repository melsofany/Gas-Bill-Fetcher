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

  # Copy ALL source (workspace needs all package.json files to resolve workspace:* deps)
  COPY . .

  # Install dependencies
  RUN pnpm install --frozen-lockfile

  # Build only the api-server (esbuild handles TS natively, no typecheck step needed)
  RUN pnpm --filter @workspace/api-server run build

  # Set working directory to api-server
  WORKDIR /app/artifacts/api-server

  EXPOSE 8080

  CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
  