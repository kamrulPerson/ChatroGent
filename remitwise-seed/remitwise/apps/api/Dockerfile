FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm i --no-audit --no-fund; fi

COPY . .

EXPOSE 4000

# Default command; compose overrides for seed
CMD ["npm", "start"]
