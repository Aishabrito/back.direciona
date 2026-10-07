# Imagem do bot para rodar na VPS com Coolify (ou em qualquer lugar com Docker).
# --- build: compila o TypeScript ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- execução: só o necessário ---
FROM node:22-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY dados ./dados
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# node direto (não "npm start") para o SIGTERM do deploy chegar ao processo e a sessão ser salva.
CMD ["node", "dist/index.js"]
