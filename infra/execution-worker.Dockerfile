FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/execution-worker/package.json apps/execution-worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/execution/package.json packages/execution/
RUN npm ci --workspace=@codetogether/execution-worker --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/execution packages/execution
COPY apps/execution-worker apps/execution-worker
CMD ["node", "--import", "tsx", "apps/execution-worker/src/main.ts"]
