import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// --- 回归锁：被跟踪文件里不得再出现已归档的上游组织标识 ---
//
// 本仓库原为某个上游仓库的 fork，但上游已归档（archived，只读），不会再产生
// 提交、也无法再合入 PR，因此本仓库改造为独立项目，所有对外标识都指向自己。
// 历史上该标识散落在安装脚本、worker 重定向、后台更新源与 README 中，且曾出现
// 「只改了一部分」的漏改。此锁用一次全局扫描兜住这类回退：只要任何被跟踪文件
// 再次出现该上游标识，测试立即失败。
//
// 为什么本文件需要豁免：断言本身必须把被禁字符串写成字面量，否则无法比对，
// 因此下面显式跳过本文件自身。豁免范围仅限本文件。
//
// 唯一的第二种豁免、以及为什么它不可被滥用：
// 说明本项目的来源是 MIT 归属的正当需要，而 `PROVENANCE_DOCS` 里的文档要写出
// 来源就必然出现该字符串。所以允许在「一对标记注释之间」提及它，但有四道约束：
//   1. 只有白名单里的说明性文档（当前仅 README.md）才可能命中该豁免，安装脚本、
//      worker、frontend、workflow 等一切可执行/可配置文件仍受绝对禁止；
//   2. 标记必须成对出现，且各恰好一次，只写一个会被判为标记残缺并失败；
//   3. 标记区之外出现该字符串一律失败——把仓库链接挪到标记外面照样会红；
//   4. 白名单文档里没有标记时不做任何剥离，也就是说「删掉标记保留链接」会失败。
// 因此这个豁免只能用来写溯源说明，无法用来夹带真实的仓库地址。

/** 上游组织名（仓库已归档）。仅本测试文件与 README 的标记区内允许出现。 */
const FORBIDDEN_UPSTREAM = 'kadidalax';

/** 构建产物 / 依赖 / 本地脚手架目录：即使在极端情况下被误提交也不纳入源码扫描。 */
const EXCLUDED_DIR_SEGMENTS = new Set(['node_modules', 'dist', '.tmp', '.workbuddy', '.git']);

/** 允许在标记区内提及上游标识的说明性文档（相对仓库根、正斜杠）。 */
const PROVENANCE_DOCS = new Set(['README.md']);

const PROVENANCE_BEGIN = '<!-- upstream-attribution:begin -->';
const PROVENANCE_END = '<!-- upstream-attribution:end -->';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const selfRelativePath = relative(repoRoot, fileURLToPath(import.meta.url)).replaceAll(sep, '/');

function listTrackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `git ls-files 失败，无法进行源码扫描：${result.stderr || result.stdout}`,
  );
  return result.stdout.split('\0').filter(Boolean);
}

function isExcluded(relativePath) {
  if (relativePath === selfRelativePath) return true;
  return relativePath.split('/').some((segment) => EXCLUDED_DIR_SEGMENTS.has(segment));
}

/** 去掉文档中被标记的溯源区段；标记残缺即失败，无标记则不剥离。 */
function stripProvenanceRegion(relativePath, content) {
  const beginCount = content.split(PROVENANCE_BEGIN).length - 1;
  const endCount = content.split(PROVENANCE_END).length - 1;
  if (beginCount === 0 && endCount === 0) return content;
  assert.equal(
    beginCount,
    1,
    `${relativePath}: 溯源标记 ${PROVENANCE_BEGIN} 应恰好出现 1 次，实际 ${beginCount} 次`,
  );
  assert.equal(
    endCount,
    1,
    `${relativePath}: 溯源标记 ${PROVENANCE_END} 应恰好出现 1 次，实际 ${endCount} 次`,
  );
  const beginIndex = content.indexOf(PROVENANCE_BEGIN);
  const endIndex = content.indexOf(PROVENANCE_END);
  assert.ok(beginIndex < endIndex, `${relativePath}: 溯源标记的顺序颠倒了`);
  return content.slice(0, beginIndex) + content.slice(endIndex + PROVENANCE_END.length);
}

test('被跟踪文件中不再出现已归档的上游仓库标识', () => {
  const tracked = listTrackedFiles();
  const scanned = tracked.filter((file) => !isExcluded(file));

  // 防呆：若 git 解析或过滤逻辑写坏导致几乎没扫到文件，扫描会“假绿”，此处直接拦下。
  assert.ok(
    scanned.length > 300,
    `扫描文件数异常偏少（${scanned.length}），源码扫描可能失效`,
  );

  const offenders = [];
  for (const relativePath of scanned) {
    const absolutePath = isAbsolute(relativePath) ? relativePath : join(repoRoot, relativePath);
    let content;
    try {
      content = readFileSync(absolutePath, 'utf8');
    } catch (error) {
      assert.fail(`无法读取被跟踪文件 ${relativePath}：${error.message}`);
    }
    if (PROVENANCE_DOCS.has(relativePath)) {
      content = stripProvenanceRegion(relativePath, content);
    }
    if (content.toLowerCase().includes(FORBIDDEN_UPSTREAM)) {
      offenders.push(relativePath);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `以下被跟踪文件仍包含已归档的上游标识 "${FORBIDDEN_UPSTREAM}"，请改指向本仓库；`
      + ` 确需在溯源说明里提及来源，请用 ${PROVENANCE_BEGIN} / ${PROVENANCE_END} 圈出：\n`
      + offenders.join('\n'),
  );
});
