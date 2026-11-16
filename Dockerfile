# QuizArena production image
FROM node:20-slim

# better-sqlite3 needs a build toolchain for its native addon
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps only
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source
COPY . .

# Persist the database here (mount a volume at /var/data in production)
ENV DATA_DIR=/var/data
ENV NODE_ENV=production
RUN mkdir -p /var/data

EXPOSE 3000
CMD ["node", "server.js"]
