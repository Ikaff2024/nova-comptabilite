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
# Applique les migrations en attente (idempotent, suivi dans _migrations) avant
# de démarrer l'API : le schéma reste toujours synchronisé avec le code déployé.
CMD ["sh", "-c", "npm run migrate && npm run start"]
