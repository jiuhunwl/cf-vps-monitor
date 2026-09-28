import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// --- 回归锁：仓库标识的「三面」必须一致 ---
//
// 本仓库的 `owner/repo` 与默认分支在三个物理位置各存一份（语言/构建边界导致
// 无法真正共享一份字面量）：
//   A. 三个安装脚本内置的常量（install.sh / install-linux.sh / install-windows.ps1）；
//   B. 前端 SSOT：`frontend/src/utils/projectLinks.ts`；
//   C. worker SSOT：`worker/src/utils/project-repository.ts`。
//
// 三个安装脚本都内置一对常量：从哪个仓库、哪个分支取源码。显式
// `--build-from-source` 和 Unix/Linux 下载预编译包失败后的源码回退都会用到，
// 拼出的地址形如 `https://github.com/<repository>/archive/refs/heads/<branch>.tar.gz`。
// 默认安装成功时走 releases/latest，所以这些常量写错不会立刻暴露。
//
// 本项目现为独立主仓库（默认分支只有 `main`，不再有上游 / dev 分支），因此：
//   1. 每个脚本的分支常量必须正好是 `main`；
//   2. 三个脚本的仓库标识必须完全相同（此前八处漏改那类问题会在此暴露）；
//   3. 三面（安装脚本 / 前端 SSOT / worker SSOT）的仓库标识与分支必须**任一一致**，
//      否则后台「关于」页展示的安装命令会从一个仓库分发脚本，而 worker 的
//      `/agent/install*` 302 与 `/update-check` 更新源却指向另一个仓库——
//      这正是本任务要消灭的核心失败模式。
//   4. 三面的仓库标识还必须分别等于写死的 `EXPECTED_REPOSITORY`。
//      只做「三面互相一致」是不够的：三面被同时改成另一个仓库时，一致性检查
//      仍会全绿。正向锚定由本文件的字面量断言与 `release-version.test.mjs`
//      共同承担，后者需要 bash 与 pwsh（Windows 上通常跑不起来），
//      因此本文件里的字面量断言是本地唯一有效的正向锁。
//
// 三面都用正则从源码里静态取值比对，不 import 任何 TS，保持本锁是纯静态检查。

/** 本独立仓库唯一的仓库标识（`owner/repo`）。 */
const EXPECTED_REPOSITORY = 'jiuhunwl/cf-vps-monitor';

/** 本独立仓库唯一允许的分支。 */
const EXPECTED_BRANCH = 'main';

/** 从源码里取出形如 `NAME="value"` 或 `$name = "value"` 的常量值。 */
function readConstant(source, pattern, label) {
  const m = source.match(pattern);
  assert.ok(m, `未能取到 ${label}，安装脚本结构已变，回归锁需同步更新`);
  return m[1];
}

const targets = [
  {
    file: 'install.sh',
    repo: /^CF_MONITOR_REPOSITORY="([^"]+)"/m,
    branch: /^CF_MONITOR_BRANCH="([^"]+)"/m,
  },
  {
    file: 'install-linux.sh',
    repo: /^CF_MONITOR_REPOSITORY="([^"]+)"/m,
    branch: /^CF_MONITOR_BRANCH="([^"]+)"/m,
  },
  {
    file: 'install-windows.ps1',
    repo: /^\$repository\s*=\s*"([^"]+)"/m,
    branch: /^\$branch\s*=\s*"([^"]+)"/m,
  },
];

const seen = [];

for (const target of targets) {
  const source = readFileSync(new URL(`./${target.file}`, import.meta.url), 'utf8');
  const repository = readConstant(source, target.repo, `${target.file} 的仓库常量`);
  const branch = readConstant(source, target.branch, `${target.file} 的分支常量`);

  assert.equal(
    branch,
    EXPECTED_BRANCH,
    `${target.file}: 分支常量是 "${branch}"，应为 "${EXPECTED_BRANCH}"。`
      + ` 该值用于 --build-from-source 的源码归档地址，写错会让整条路径 404。`,
  );

  // 正向锚定：三面互相一致只能证明「没有漂移」，无法证明「指向的是本仓库」。
  // 若三面被同时改成另一个仓库，互相一致的检查会全绿，所以必须对期望字面量
  // 单独断言一次。本文件是纯静态检查（不依赖 bash / pwsh），
  // 是 Windows 上唯一能本地跑起来的正向锁。
  assert.equal(
    repository,
    EXPECTED_REPOSITORY,
    `${target.file}: 仓库常量是 "${repository}"，应为 "${EXPECTED_REPOSITORY}"。`
      + ' 该值用于 releases 与源码归档地址，写错会让安装与卸载都指向另一个仓库。',
  );

  seen.push({ file: target.file, repository, branch });
}

// 三个脚本装的是同一个 agent，仓库与分支必须一致；
// 只改其中一个（此前八处漏改那类问题）同样要报错。
const [first, ...rest] = seen;
for (const other of rest) {
  assert.equal(
    other.repository,
    first.repository,
    `${other.file} 的仓库常量与 ${first.file} 不一致：${other.repository} vs ${first.repository}`,
  );
  assert.equal(
    other.branch,
    first.branch,
    `${other.file} 的分支常量与 ${first.file} 不一致：${other.branch} vs ${first.branch}`,
  );
}

// 与前端保持同源：后台展示的安装命令从同一分支拉取 install.sh，
// 脚本再从同一仓库、同一分支拉源码，两者必须一致。
// 仓库与分支常量的权威定义在 projectLinks.ts（agentInstallCommand.ts 只是转出）。
const frontendSource = readFileSync(
  new URL('../frontend/src/utils/projectLinks.ts', import.meta.url),
  'utf8',
);
const frontendRepo = readConstant(
  frontendSource,
  /CF_MONITOR_REPOSITORY\s*=\s*'([^']+)'/,
  '前端的仓库常量',
);
const frontendBranch = readConstant(
  frontendSource,
  /CF_MONITOR_BRANCH\s*=\s*'([^']+)'/,
  '前端的分支常量',
);
assert.equal(
  frontendRepo,
  first.repository,
  `前端仓库常量 ${frontendRepo} 与安装脚本 ${first.repository} 不一致`,
);
assert.equal(
  frontendRepo,
  EXPECTED_REPOSITORY,
  `前端仓库常量 ${frontendRepo} 应为 ${EXPECTED_REPOSITORY}；`
    + ' 否则后台生成的安装命令会从另一个仓库取脚本',
);
assert.equal(
  frontendBranch,
  EXPECTED_BRANCH,
  `前端分支常量 ${frontendBranch} 应为 ${EXPECTED_BRANCH}`,
);
assert.equal(
  frontendBranch,
  first.branch,
  `前端会从分支 ${frontendBranch} 拉取 install.sh，`
    + `而脚本内置分支是 ${first.branch}，两者必须一致`,
);

// 第三面：worker SSOT。worker 的 `/agent/install*` 302 与 `/update-check`
// 更新源都从该常量派生，它一旦与前端/安装器漂移，就会出现「后台展示的安装
// 命令指向 A 仓库、worker 重定向与更新源却指向 B 仓库」的隐性不一致。
// 同样用正则静态取值，不 import worker 的 TS。
const workerSource = readFileSync(
  new URL('../worker/src/utils/project-repository.ts', import.meta.url),
  'utf8',
);
const workerRepo = readConstant(
  workerSource,
  /CF_MONITOR_REPOSITORY\s*=\s*'([^']+)'/,
  'worker 的仓库常量',
);
const workerBranch = readConstant(
  workerSource,
  /CF_MONITOR_BRANCH\s*=\s*'([^']+)'/,
  'worker 的分支常量',
);
assert.equal(
  workerRepo,
  first.repository,
  `worker 仓库常量 ${workerRepo} 与安装脚本 ${first.repository} 不一致；`
    + ' 否则 worker 的 /agent/install* 302 与 /update-check 会指向另一个仓库',
);
assert.equal(
  workerRepo,
  EXPECTED_REPOSITORY,
  `worker 仓库常量 ${workerRepo} 应为 ${EXPECTED_REPOSITORY}；`
    + ' 否则 worker 的 /agent/install* 302 与 /update-check 会指向另一个仓库',
);
assert.equal(
  workerBranch,
  EXPECTED_BRANCH,
  `worker 分支常量 ${workerBranch} 应为 ${EXPECTED_BRANCH}`,
);
assert.equal(
  workerBranch,
  first.branch,
  `worker 分支常量 ${workerBranch} 与安装脚本分支 ${first.branch} 不一致`,
);
