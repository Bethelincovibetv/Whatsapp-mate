# Multi-stage production Dockerfile for Google Cloud Run
# Optimized for Baileys WhatsApp Web Socket + Node.js 22 LTS

FROM node:22-slim AS builder

WORKDIR /app

# Install build dependencies
COPY package*.json ./
RUN npm ci

# Copy source code and build React frontend
COPY . .
RUN npm run build

# Production runtime stage
FROM node:22-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install production dependencies only
COPY package*.json ./
RUN npm ci --only=production

# Copy built frontend assets and server files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/schema.sql ./schema.sql
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Install tsx globally or run via npx for lightweight TypeScript execution
RUN npm install -g tsx

EXPOSE 3000

# Start server using tsx
CMD ["tsx", "server.ts"]
