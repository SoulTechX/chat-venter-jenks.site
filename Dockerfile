FROM node:20-alpine
WORKDIR /app

# Dependencias para better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN apk add --no-cache python3 make g++
RUN npm install --production
COPY . .
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "server.js"]
