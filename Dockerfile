# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 api
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER api
EXPOSE 4000
CMD ["node", "dist/server.js"]
