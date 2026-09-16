FROM node:24-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5174

COPY --from=builder /app/dist ./dist
COPY server ./server
COPY data/ziqu-catalog.sqlite ./data/ziqu-catalog.sqlite

EXPOSE 5174
CMD ["node", "server/index.mjs"]
