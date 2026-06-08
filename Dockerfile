FROM node:22-slim

  # Install dependencies for Playwright
  RUN apt-get update && apt-get install -y \
      libnss3 \
      libnspr4 \
      libdbus-1-3 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libcairo2 \
      libxcb1 \
      libxcb-shm0 \
      libxcursor1 \
      libxi6 \
      libxext6 \
      libxss1 \
      libxtst6 \
      fonts-liberation \
      libappindicator3-1 \
      libc6 \
      ca-certificates \
      fonts-noto-cjk \
      && rm -rf /var/lib/apt/lists/*

  WORKDIR /app

  # Install pnpm (latest)
  RUN npm install -g pnpm

  # Copy package manifests
  COPY package.json pnpm-workspace.yaml .npmrc ./

  # Install dependencies (no lockfile enforcement to allow resolution in Docker)
  RUN pnpm install --no-frozen-lockfile

  # Copy source code
  COPY . .

  # Build only the api-server (esbuild bundles TS directly, no typecheck needed)
  RUN pnpm --filter @workspace/api-server run build

  # Set working directory to API server
  WORKDIR /app/artifacts/api-server

  # Expose port
  EXPOSE 8080

  # Start the application
  CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
  