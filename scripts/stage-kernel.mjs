// 构建内核二进制并按 Tauri externalBin 的命名约定放到 src-tauri/binaries/。
//
// Tauri 要求 sidecar 文件名带 target triple 后缀(riot-kernel-<triple>),
// dev 和 build 都会检查它存在;打包时再去掉后缀放进 app bundle(macOS 是
// Contents/MacOS/riot-kernel,恰好在宿主可执行文件旁边 —— locate_kernel
// 就按这个约定找)。
//
// 命令行启动器 riot-cli 同理(见 crates/riot-cli):它和主程序放在同一个目录,
// 「安装命令行工具」再把它链 / 复制成用户 PATH 上的 `riot`。
//
// 用法:node scripts/stage-kernel.mjs [debug|release]

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const profile = process.argv[2] === 'release' ? 'release' : 'debug';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = process.platform === 'win32' ? '.exe' : '';

execSync(`cargo build -p riot-kernel -p riot-cli${profile === 'release' ? ' --release' : ''}`, {
  cwd: root,
  stdio: 'inherit',
});

// 新 rustc 有 --print host-tuple;老版本从 -vV 的 host: 行解析。
function hostTriple() {
  try {
    return execSync('rustc --print host-tuple', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    const info = execSync('rustc -vV').toString();
    const m = /host: (\S+)/.exec(info);
    if (!m) throw new Error('确定不了 target triple(rustc -vV 里没有 host: 行)');
    return m[1];
  }
}

function cargoTargetDir() {
  const raw = execSync('cargo metadata --no-deps --format-version 1', {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
  const dir = JSON.parse(raw).target_directory;
  if (!dir) throw new Error('cargo metadata 没有 target_directory');
  return dir;
}

const triple = hostTriple();
const destDir = path.join(root, 'src-tauri', 'binaries');
fs.mkdirSync(destDir, { recursive: true });
for (const name of ['riot-kernel', 'riot-cli']) {
  const src = path.join(cargoTargetDir(), profile, `${name}${ext}`);
  const dest = path.join(destDir, `${name}-${triple}${ext}`);
  fs.copyFileSync(src, dest);
  console.log(`${name} 已就位:${path.relative(root, dest)}(${profile})`);
}
