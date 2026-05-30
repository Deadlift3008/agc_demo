FROM node:20-alpine
WORKDIR /app
# Сначала манифест + lock: ставим строго по lock-файлу (воспроизводимо).
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 8080
CMD ["npm", "run", "dev"]
