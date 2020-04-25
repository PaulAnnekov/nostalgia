FROM node:12.16.2-alpine3.11

RUN apk add python3 make

WORKDIR /app

RUN chown node: /app

USER node

COPY index.ts index.ts
COPY package.json package.json
COPY package-lock.json package-lock.json
COPY tsconfig.json tsconfig.json

RUN npm ci
