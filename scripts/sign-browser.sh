#!/usr/bin/env bash
#
# 给内置浏览器（riot-browser.app）做 Developer ID 签名。
#
# 为什么需要单独一步:
#
# Tauri 的 bundler 只签外层 Riot.app 和 externalBin，不会递归签
# Contents/Resources 里的嵌套 .app。而公证服务会把包内所有 Mach-O
# 逐个检查 —— CEF 的 Framework、5 个 helper .app、Libraries 下的
# dylib 只要有一层没签名、没开 hardened runtime、没有安全时间戳，
# 整包就会被拒。
#
# 顺序必须从内到外: 先 dylib，再 Framework，再 helper .app，再主
# 可执行文件，最后整个 .app。反过来签会被外层签名覆盖掉内层。
#
# 用法:
#   APPLE_SIGNING_IDENTITY="Developer ID Application: ..." \
#   APPLE_CERTIFICATE="$(base64 -i cert.p12 | tr -d '\n')" \
#   APPLE_CERTIFICATE_PASSWORD="..." \
#   ./scripts/sign-browser.sh [path/to/riot-browser.app]
#
# 没设 APPLE_SIGNING_IDENTITY 时直接跳过 —— 本地开发仍可打未签名包。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:-$ROOT/crates/riot-browser/target/bundle/riot-browser.app}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "非 macOS，跳过内置浏览器签名"
  exit 0
fi

if [[ ! -d "$APP" ]]; then
  echo "找不到浏览器包: $APP" >&2
  exit 1
fi

IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  echo "未设置 APPLE_SIGNING_IDENTITY，跳过内置浏览器签名"
  exit 0
fi

TMP="$(mktemp -d)"
KC="$TMP/riot-sign.keychain-db"
KC_PASS="$(uuidgen)"
ORIG_KC=()

cleanup() {
  if [[ ${#ORIG_KC[@]} -gt 0 ]]; then
    security list-keychains -d user -s "${ORIG_KC[@]}" >/dev/null 2>&1 || true
  fi
  security delete-keychain "$KC" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

if [[ -n "${APPLE_CERTIFICATE:-}" ]]; then
  printf '%s' "$APPLE_CERTIFICATE" | base64 -D > "$TMP/cert.p12"
  security create-keychain -p "$KC_PASS" "$KC"
  security set-keychain-settings -lut 21600 "$KC"
  security unlock-keychain -p "$KC_PASS" "$KC"
  security import "$TMP/cert.p12" -k "$KC" \
    -P "${APPLE_CERTIFICATE_PASSWORD:?APPLE_CERTIFICATE_PASSWORD 未设置}" \
    -T /usr/bin/codesign -T /usr/bin/security >/dev/null

  # 临时钥匙串里只有叶子证书，codesign 建不出链。把 Apple 的中间证书
  # 一起导进去，find-identity 才会把它认成有效身份。这一步要在改搜索
  # 列表之前做 —— 那时还能搜到登录钥匙串和系统钥匙串里的中间证书。
  security find-certificate -a -c "Developer ID Certification Authority" -p \
    > "$TMP/intermediate.pem" 2>/dev/null || true
  if [[ -s "$TMP/intermediate.pem" ]]; then
    security import "$TMP/intermediate.pem" -k "$KC" -T /usr/bin/codesign >/dev/null
  fi

  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KC_PASS" "$KC" >/dev/null

  if security find-identity -v -p codesigning "$KC" | grep -q "0 valid identities found"; then
    echo "临时钥匙串里没有可用的签名身份，检查证书和中间证书" >&2
    security find-identity -v -p codesigning "$KC" >&2 || true
    exit 1
  fi

  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line#\"}"
    line="${line%\"}"
    ORIG_KC+=("$line")
  done < <(security list-keychains -d user)
  # 临时钥匙串放第一位，让 codesign 优先选中可访问的私钥；后面保留
  # 原来的钥匙串，因为 Apple 的中间证书还在登录钥匙串里，建签名链要用。
  security list-keychains -d user -s "$KC" "${ORIG_KC[@]}" >/dev/null
fi

sign() {
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$1"
}

# 1. CEF 自带的 dylib
if [[ -d "$APP/Contents/Frameworks/Chromium Embedded Framework.framework/Libraries" ]]; then
  while IFS= read -r -d '' f; do
    sign "$f"
  done < <(find "$APP/Contents/Frameworks/Chromium Embedded Framework.framework/Libraries" \
    -type f -name '*.dylib' -print0)
fi

# 2. CEF Framework 本身
if [[ -d "$APP/Contents/Frameworks/Chromium Embedded Framework.framework" ]]; then
  sign "$APP/Contents/Frameworks/Chromium Embedded Framework.framework"
fi

# 3. 五个 helper .app
while IFS= read -r -d '' h; do
  sign "$h"
done < <(find "$APP/Contents/Frameworks" -maxdepth 1 -type d -name '*.app' -print0)

# 4. 主可执行文件
sign "$APP/Contents/MacOS/riot-browser"

# 5. 整个 .app
sign "$APP"

codesign --verify --deep --strict --verbose=2 "$APP"
echo "内置浏览器签名完成: $APP"
