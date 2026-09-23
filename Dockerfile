# Build stage
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production stage
FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && chown -R node:node /app

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/proto ./proto

# Informational only: runtime port is $PORT (default 3000, see src/main.ts); compose maps ${PORT:-3000}:${PORT:-3000}.
# gRPC push microservice binds $GRPC_URL (default 0.0.0.0:50051, see src/push/push.constants.ts).
EXPOSE 3000 50051

USER node

CMD ["node", "dist/main"]
