/**
 * 找出「已提交的文件 import 了未提交的文件」。
 *
 * 这类错误本地一定发现不了：文件都在磁盘上，tsc、测试、next build 全过。
 * 只有从仓库干净 checkout 的 CI 会炸，而那时错误信息指向的是被 import 的
 * 模块，不是漏提交的那个人。
 *
 * 检查的是 HEAD 的内容，不是工作区 —— 那才是 CI 实际拿到的东西。
 */

import { execSync } from "node:child_process";
import path from "node:path";

const sh = (cmd) => execSync(cmd, { encoding: "utf8", maxBuffer: 1 << 26 });

const files = sh("git ls-tree -r --name-only HEAD").split("\n").filter(Boolean);
const tracked = new Set(files);
const sources = files.filter((f) => /^src\/.*\.tsx?$/.test(f));

// 解析顺序要和打包器一致：先当文件，再当目录里的 index。
const CANDIDATES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

let broken = 0;
for (const file of sources) {
  const text = sh(`git show HEAD:"${file}"`);
  for (const [, spec] of text.matchAll(/from\s+"([^"]+)"/g)) {
    let base;
    if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
    else if (spec.startsWith(".")) {
      base = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    } else continue; // 包依赖，交给 npm

    if (!CANDIDATES.some((ext) => tracked.has(base + ext))) {
      console.error(`✗ ${file}\n    import "${spec}" —— 目标不在仓库里`);
      broken += 1;
    }
  }
}

if (broken > 0) {
  console.error(`\n${broken} 处悬空 import。八成是有文件忘了 git add。`);
  process.exit(1);
}
console.log(`✓ ${sources.length} 个文件的 import 全部指向已提交的文件`);
