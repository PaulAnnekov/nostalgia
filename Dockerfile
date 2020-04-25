FROM node:12.16.2-alpine3.11

RUN apk add python3 make

WORKDIR /app

RUN chown node: /app

USER node

COPY src/index.ts index.ts
COPY src/package.json package.json
COPY src/package-lock.json package-lock.json
COPY src/tsconfig.json tsconfig.json

RUN npm ci
