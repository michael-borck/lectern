# node:22-slim (Debian) — easy LibreOffice; build stage compiles better-sqlite3
FROM node:22-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim

# poppler: pdftoppm (PDF -> PNG)   libreoffice-impress: soffice (PPTX -> PDF)
# fonts-liberation/carlito: metric-compatible substitutes for Arial/Calibri
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     poppler-utils \
     libreoffice-impress \
     fonts-liberation \
     fonts-crosextra-carlito \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server.js db.js auth.js email.js convert.js ./
COPY public ./public
COPY scripts ./scripts

# runtime state lives in volumes:
#   -v ./presentations:/app/presentations   (slide decks, read-write: uploads land here)
#   -v ./data:/app/data                     (SQLite: users, sessions, decks)
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
