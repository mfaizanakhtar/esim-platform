# Multi-stage Dockerfile for eSIM Backend
# Can run as API or Worker based on CMD override

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./
COPY tsconfig.build.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Copy source code
COPY src ./src
COPY scripts ./scripts

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript (outputs to dist/src/ and dist/scripts/)
RUN npm run build

# Stage 2: Production
FROM node:20-alpine AS production

WORKDIR /app

# Install OpenSSL 3 for Prisma (Alpine 3.17+ uses OpenSSL 3)
RUN apk add --no-cache openssl openssl-dev

# Set NODE_ENV before installing so npm lifecycle scripts also see it
ENV NODE_ENV=production

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy Prisma schema
COPY prisma ./prisma/

# Generate Prisma client for correct OpenSSL version
ENV PRISMA_CLI_BINARY_TARGETS="linux-musl-openssl-3.0.x"
RUN npx prisma generate

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Change ownership
RUN chown -R nodejs:nodejs /app

USER nodejs

# Expose port (API only, but doesn't hurt for worker)
EXPOSE 3000

# Run initialization script (migrations + seeding), then start app
# For API: init runs before server starts
# For Worker: init runs (idempotent) before worker starts
CMD ["sh", "-c", "node dist/scripts/init-railway.js && node dist/src/index.js"]