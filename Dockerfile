FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public/ ./public/

# SQLite data persists via a mounted volume
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "--experimental-sqlite", "server.js"]
