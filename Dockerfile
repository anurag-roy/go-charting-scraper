FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY investigation/evidence ./investigation/evidence
COPY logs ./logs

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
