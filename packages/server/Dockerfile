FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile=false
COPY packages/shared packages/shared
COPY packages/server packages/server
WORKDIR /app/packages/server
EXPOSE 3400
CMD ["pnpm", "start"]
