# Riot 无界面版的镜像。发版的现成镜像是 ghcr.io/riot-org/riot-server:<版本>
# （x86_64 / arm64），自己编就在仓库根目录：
#
#   docker build -f deploy/server/Dockerfile -t riot-server .
#   docker run -d --name riot -p 127.0.0.1:7823:7823 -v riot-home:/home/riot \
#     --security-opt seccomp=unconfined --security-opt apparmor=unconfined riot-server
#   docker exec riot riot-server token --listen 127.0.0.1:7823   # 登录链接
#
# 端口只映射到宿主机的 127.0.0.1：网页版不带 TLS，对外请经反向代理或隧道。
# 容器里监听 0.0.0.0 只是为了让端口映射进得来。
#
# 两个 unconfined 是给命令沙箱（bubblewrap）的：Docker 默认的 seccomp / AppArmor
# 配置不允许在容器里建 user namespace。不加也能跑，只是设置里的沙箱状态会显示
# 不可用、命令不隔离。
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
      cmake ninja-build \
 && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH=/root/.cargo/bin:$PATH
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p riot-host --no-default-features --bin riot-server \
 && cargo build --release --locked -p riot-kernel
# 内置浏览器（CEF）。cef-dll-sys 构建时自己下载 CEF，产物是 riot-browser/ 平铺目录。
# 它的 build.rs 用 cmake + Ninja 编 CEF 的 C++ 包装层，所以上面要装 cmake、ninja-build。
RUN scripts/build-browser.sh /out

FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
# 第二行起是 CEF 的运行时依赖（libcef.so 链接的那些，不含 GTK）和字体 ——
# 没有字体时页面上的字全是方块，CJK 字体缺了中文页面同样是方块。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git openssh-client curl less procps ripgrep tini bubblewrap \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdbus-1-3 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
      libpango-1.0-0 libcairo2 libasound2 libx11-6 libxcb1 libxext6 libexpat1 libglib2.0-0 \
      fonts-liberation fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash riot
COPY --from=build /src/target/release/riot-server /src/target/release/riot-kernel /opt/riot/
COPY --from=build /out/riot-browser /opt/riot/riot-browser
COPY --from=web /src/dist /opt/riot/web
RUN ln -s /opt/riot/riot-server /usr/local/bin/riot-server
USER riot
WORKDIR /home/riot
ENV RIOT_LISTEN=0.0.0.0:7823 \
    RIOT_LOG=info
EXPOSE 7823
VOLUME ["/home/riot"]
# tini 当 PID 1：agent 跑的命令留下的孤儿进程会被收养到 PID 1，没人回收就成了僵尸。
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/riot/riot-server"]
