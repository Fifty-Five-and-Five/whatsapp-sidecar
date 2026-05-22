FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
RUN mkdir -p /session && chown -R node:node /app /session
USER node
EXPOSE 3030
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
