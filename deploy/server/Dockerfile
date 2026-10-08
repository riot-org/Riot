# Riot 无界面版的镜像。在仓库根目录构建：
#
#   docker build -f deploy/server/Dockerfile -t riot-server .
#   docker run -d --name riot -p 127.0.0.1:7823:7823 -v riot-home:/home/riot riot-server
#   docker exec riot riot-server token --listen 127.0.0.1:7823   # 登录链接
#
# 端口只映射到宿主机的 127.0.0.1：网页版不带 TLS，对外请经反向代理或隧道。
# 容器里监听 0.0.0.0 只是为了让端口映射进得来。
#
# 镜像里只有最基本的命令行工具。agent 要用的语言运行时（node、python、
# 编译器……）按项目需要在这个镜像上再 FROM 一层装。

FROM node:22-bookworm AS web
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# 在 22.04 上编：glibc 2.35，产物在更新的发行版上也能跑。
FROM ubuntu:22.04 AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential pkg-config curl ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH=/root/.cargo/bin:$PATH
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p riot-host --no-default-features --bin riot-server \
 && cargo build --release --locked -p riot-kernel

FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git openssh-client curl less procps ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash riot
COPY --from=build /src/target/release/riot-server /src/target/release/riot-kernel /opt/riot/
COPY --from=web /src/dist /opt/riot/web
RUN ln -s /opt/riot/riot-server /usr/local/bin/riot-server
USER riot
WORKDIR /home/riot
ENV RIOT_LISTEN=0.0.0.0:7823 \
    RIOT_LOG=info
EXPOSE 7823
VOLUME ["/home/riot"]
ENTRYPOINT ["/opt/riot/riot-server"]
