FROM node:22-alpine

WORKDIR /app

# 无第三方依赖，仅拷贝源码
COPY package.json ./package.json
COPY server.js ./server.js
COPY admin ./admin
COPY README.md ./README.md

# 持久化目录（账号与 token 会写入 data/accounts.json）
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATA_DIR=/app/data
ENV ACCOUNTS_FILE=/app/data/accounts.json

EXPOSE 8787

CMD ["node", "server.js"]
