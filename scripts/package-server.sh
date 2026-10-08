#!/usr/bin/env bash
# 打 riot-server 的 Linux 发行包：无界面宿主 + 内核 + 前端产物 + systemd unit。
#
#   pnpm build && scripts/package-server.sh [输出目录]
#
# 包的布局就是 riot-server 默认的查找布局（见 src-tauri/src/headless.rs）：
# 内核在二进制旁边，前端在旁边的 web/。解压到哪都能直接跑。
set -euo pipefail
cd "$(dirname "$0")/.."

out=${1:-target/server-dist}
version=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
arch=$(uname -m)

if [[ ! -f dist/index.html ]]; then
  echo "dist/ 还没建：先跑 pnpm build" >&2
  exit 1
fi

cargo build --release --locked -p riot-host --no-default-features --bin riot-server
cargo build --release --locked -p riot-kernel

name="riot-server-${version}-linux-${arch}"
stage="$out/$name"
rm -rf "$stage"
mkdir -p "$stage"
cp target/release/riot-server target/release/riot-kernel "$stage/"
cp -R dist "$stage/web"
cp deploy/server/riot-server.service "$stage/"
tar -C "$out" -czf "$out/$name.tar.gz" "$name"
echo "$out/$name.tar.gz"
