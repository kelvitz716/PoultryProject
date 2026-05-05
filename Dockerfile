FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy application files
COPY . .

# Create data directory for SQLite
RUN mkdir -p data

EXPOSE 80

CMD ["node", "server.js"]
