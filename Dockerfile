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

EXPOSE 3000

USER node

CMD ["node", "dist/main"]
