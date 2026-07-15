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
# Applique les migrations en attente en mode « best-effort » (ne bloque JAMAIS
# le démarrage : une migration en erreur est ignorée), puis démarre l'API. Le
# schéma se synchronise au déploiement sans risquer un conteneur qui ne boote pas.
CMD ["sh", "-c", "node scripts/migrate-boot.mjs; npm run start"]
