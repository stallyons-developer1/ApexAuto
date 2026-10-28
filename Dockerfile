# Railway build: Playwright image ships Chromium + its system libraries (needed by the TruthFinder worker).
# Keep the image tag and the "playwright" version in package.json identical.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
CMD ["node", "dev-server.js"]
