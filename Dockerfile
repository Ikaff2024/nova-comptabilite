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
# migrate -> verify -> start, FAIL-CLOSED.
#
# `&&` et non `;` : si les migrations échouent, l'API ne démarre pas. C'était
# l'inverse auparavant (mode « best-effort », erreurs ignorées, démarrage
# systématique), ce qui laissait servir un schéma incomplet — donc, depuis la
# vague P0, potentiellement sans verrou d'immuabilité ni FORCE ROW LEVEL
# SECURITY. Un conteneur qui ne boote pas se voit ; une comptabilité fausse, non.
#
# Le processus API revérifie ensuite le schéma et les invariants de sécurité
# avant d'ouvrir son port (server/startup.ts) : si l'hébergeur remplace cette
# commande et saute l'étape de migration, Nova refuse de démarrer et le dit.
CMD ["sh", "-c", "npm run migrate && npm run start"]
