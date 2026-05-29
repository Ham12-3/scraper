# Build context must be the root scraper/ directory so both modules are available.
# docker-compose sets: context: . and dockerfile: module3-kafka-worker/Dockerfile

# Stage 1: Build module1 (BrowserCluster)
FROM node:20-slim AS module1-build
WORKDIR /build
COPY module1-browser-controller/package.json module1-browser-controller/package-lock.json* ./
RUN npm install --ignore-scripts
COPY module1-browser-controller/src ./src
COPY module1-browser-controller/tsconfig.json ./
RUN npx tsc --project tsconfig.json

# Stage 2: Build module3 (KafkaWorker)
FROM node:20-slim AS module3-build
WORKDIR /build/module1-browser-controller
COPY --from=module1-build /build/dist ./dist
COPY --from=module1-build /build/node_modules ./node_modules
COPY module1-browser-controller/package.json ./

WORKDIR /build/module3-kafka-worker
COPY module3-kafka-worker/package.json module3-kafka-worker/package-lock.json* ./
RUN npm install --ignore-scripts
COPY module3-kafka-worker/src ./src
COPY module3-kafka-worker/tsconfig.json ./
RUN npx tsc --project tsconfig.json

# Stage 3: Runtime with Playwright Chromium
FROM mcr.microsoft.com/playwright:v1.44.0-jammy AS runtime
WORKDIR /app

# Module 3 runtime — copy node_modules first so @scraper/browser-controller can be overwritten
COPY --from=module3-build /build/module3-kafka-worker/dist ./dist
COPY --from=module3-build /build/module3-kafka-worker/node_modules ./node_modules
COPY module3-kafka-worker/package.json ./

# Replace the file: reference with the actual built module1 output
COPY --from=module3-build /build/module1-browser-controller /app/node_modules/@scraper/browser-controller

ENV NODE_ENV=production

CMD ["node", "dist/main.js"]
