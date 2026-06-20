FROM node:22-alpine

# Production dependencies only
WORKDIR /app

# Install deps (including devDeps for build steps)
COPY package*.json ./
COPY vue/package*.json ./vue/
RUN npm ci --omit=dev || npm install --omit=dev
RUN cd vue && npm ci || npm install

# Build the Vue frontend
COPY vue/ ./vue/
RUN cd vue && npm run build

# Copy app source
COPY index.js ./
COPY src/ ./src/

# Cache directory (bind-mounted in compose)
RUN mkdir -p /app/cache

ENV NODE_ENV=production
ENV PORT=7700

EXPOSE 7700

# Health check: hit the manifest endpoint
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -q --spider http://localhost:7700/manifest.json || exit 1

CMD ["node", "index.js"]
