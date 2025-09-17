# Dockerfile

# --- Stage 1: Build & Cache ---
FROM denoland/deno:alpine AS builder

WORKDIR /app

# 优先缓存依赖项
COPY src/ src/
RUN deno cache src/server.ts

# --- Stage 2: Final Production Image ---
FROM denoland/deno:alpine

WORKDIR /app
USER deno

# 从 builder 阶段拷贝缓存的依赖
COPY --from=builder /deno-dir/ /deno-dir/
ENV DENO_DIR=/deno-dir

# 拷贝应用代码
COPY src/ src/
COPY public/ public/

# 暴露端口 (你在后端代码中配置的端口)
EXPOSE 8000

# 定义容器启动命令
CMD ["deno", "task", "start"]