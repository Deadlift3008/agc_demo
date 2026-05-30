FROM node:20-alpine
WORKDIR /app
# Сначала манифест + lock: ставим строго по lock-файлу (воспроизводимо).
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host"]
