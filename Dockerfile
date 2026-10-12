FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY seed ./seed
# сертификат Минцифры — без него бот не подключится к API MAX
COPY certs ./certs
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "server/index.js"]
