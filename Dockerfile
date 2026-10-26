# 构建 Vite 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 同源代理保留 XG 和 Agent 的长请求、SSE 及图片下载。
FROM nginx:1.28-alpine

COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY web/docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
ENV XG_API_BASE_URL=http://host.docker.internal:18080 \
    XG_API_KEY="" \
    NGINX_ENVSUBST_FILTER="^(XG_API_BASE_URL|XG_API_KEY)$"
RUN sed -i 's/\r$//' /docker-entrypoint.d/40-runtime-config.sh \
    && chmod +x /docker-entrypoint.d/40-runtime-config.sh

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:3000/healthz || exit 1
