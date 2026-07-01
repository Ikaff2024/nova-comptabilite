# Nova Comptabilité — image unique : API Express qui sert aussi le front build.
FROM node:22-slim

WORKDIR /app

# Dépendances (toutes : vite/tsx nécessaires au build et au runtime)
COPY package*.json ./
RUN npm ci

# Code + build du front (-> dist/)
COPY . .
RUN npm run build

# Runtime
ENV NODE_ENV=production
ENV SERVE_STATIC=true
EXPOSE 4000
CMD ["npm", "run", "start"]
