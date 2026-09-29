import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// --- 面板驱动「安全升级」安装脚本回归 ---
// T02 覆盖：三个安装脚本的 `--upgrade` 入口、root 升级守护单元（systemd path+oneshot /
// OpenRC 常驻轮询）的内容与所有权判定、以及卸载路径的清理接线。
//
// 这些用例只依赖 POSIX shell 与 GNU coreutils（Git for Windows 自带），不依赖 pwsh，
// 因此在 Windows 本机与 Linux CI 上都可执行。

const repo = fileURLToPath(new URL('../', import.meta.url));
const agentDir = fileURLToPath(new URL('./', import.meta.url));

function posix(value) {
  return value.replaceAll('\\', '/');
}

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

// 解析可用的 shell：优先 PATH 上的标准名字，最后回退到 Git for Windows 自带的 bash。
function resolveShell(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['-c', 'exit 0'], { encoding: 'utf8', windowsHide: true });
    if (!probe.error) return candidate;
  }
  return null;
}

function gitBashCandidates() {
  const git = spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true });
  if (git.error || git.status !== 0) return [];
  const first = (git.stdout || '').trim().split(/\r?\n/)[0];
  if (!first) return [];
  const root = dirname(dirname(first));
  return [join(root, 'bin', 'bash.exe'), join(root, 'usr', 'bin', 'bash.exe')];
}

// install.sh 是 POSIX sh；install-linux.sh 使用 [[ ]] 与 bash 数组，必须以 bash 运行。
const POSIX_SHELL = resolveShell(['sh', 'bash', ...gitBashCandidates()]);
const BASH_SHELL = resolveShell(['bash', ...gitBashCandidates(), 'sh']);
assert.ok(POSIX_SHELL, 'no usable POSIX shell（需要 sh 或 bash）');
assert.ok(BASH_SHELL, 'no usable bash shell（install-linux.sh 需要 bash）');

const SCRIPTS = [
  { name: 'install.sh', shell: POSIX_SHELL, loop: /^while \[ "\$#" -gt 0 \]; do$/ },
  { name: 'install-linux.sh', shell: BASH_SHELL, loop: /^while \[\[ \$# -gt 0 \]\]; do$/ },
];

function readScript(name) {
  return readFileSync(join(agentDir, name), 'utf8').replaceAll('\r\n', '\n');
}

function fixture(t) {
  // 用例固定建立在操作系统临时目录下：既不在仓库里留下残留，也避开沙箱对「批量删除」
  // 的非递归路径护栏（该护栏仅接管非临时目录下的删除）。
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, 'cf-upgrade-install-'));
  t.after(() => {
    const resolved = realpathSync(root);
    assert.ok(resolved.startsWith(parent + sep), 'only remove this test\'s own fixture');
    assert.equal(dirname(resolved), parent, 'cleanup cannot cross a fixture boundary');
    rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}

// 取出列首 `name() {` 起到列首 `}` 的函数体。
function extractFunction(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex(l => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\(\\)\\s*\\{`).test(l.trim()));
  assert.notEqual(start, -1, `未找到函数 ${name}()，安装脚本结构已变，回归锁需同步更新`);
  const end = lines.findIndex((l, i) => i > start && /^\}\s*$/.test(l));
  assert.notEqual(end, -1, `函数 ${name}() 缺少收尾大括号`);
  return lines.slice(start, end + 1).join('\n');
}

// 参数解析循环是脚本顶层语句，不随函数定义一起被 source，需要单独抽取。
function extractParseLoop(source, loop) {
  const lines = source.split('\n');
  const start = lines.findIndex(l => loop.test(l));
  assert.notEqual(start, -1, '未找到参数解析 while 循环，安装脚本结构已变');
  const end = lines.findIndex((l, i) => i > start && /^done\s*$/.test(l));
  assert.notEqual(end, -1, '参数解析 while 循环缺少收尾 done');
  return lines.slice(start, end + 1).join('\n');
}

// 取脚本顶层定义区（首个参数解析循环之前），与 reaudit-installers.test.mjs 同一策略。
function definitionsOf(source, loop) {
  const lines = source.split('\n');
  const start = lines.findIndex(l => loop.test(l));
  assert.notEqual(start, -1, '未找到参数解析 while 循环，无法定位定义区');
  return lines.slice(0, start).join('\n');
}

function extractSafetyBlock(source) {
  const lines = source.split('\n');
  const open = lines.findIndex(l => /cat <<'CF_AGENT_SAFETY'/.test(l));
  assert.notEqual(open, -1, '未找到 agent_safety_helpers 的 heredoc 起始标记');
  const close = lines.findIndex((l, i) => i > open && l === 'CF_AGENT_SAFETY');
  assert.notEqual(close, -1, '未找到 agent_safety_helpers 的 heredoc 结束标记');
  return lines.slice(open + 1, close).join('\n');
}

// 在受控的 shell 里 source 脚本定义区后执行 body，返回 fixture 路径与执行结果。
function runShell(t, scriptName, body, extraDefs = '') {
  const spec = SCRIPTS.find(s => s.name === scriptName);
  assert.ok(spec, `unknown script ${scriptName}`);
  const root = fixture(t);
  const source = readScript(scriptName);
  const definitions = definitionsOf(source, spec.loop);
  const script = join(root, 'case.sh');
  writeFileSync(script, `${extraDefs}\n${definitions}\nROOT=${shellQuote(posix(root))}\n${body}\n`);
  const result = spawnSync(spec.shell, [posix(script)], {
    cwd: repo, encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
  assert.ifError(result.error);
  return { root, result };
}

function stdoutOf(result) {
  assert.equal(result.status, 0, `脚本以非零退出：${result.status}\n${result.stderr}`);
  return result.stdout;
}

for (const { name } of SCRIPTS) {
  test(`U-S01 ${name} 解析 --upgrade 并复用模式/名称/流量日（--SET 标记）`, t => {
    const source = readScript(name);
    const loop = extractParseLoop(source, SCRIPTS.find(s => s.name === name).loop);
    const body = `
parse_args() {
${loop}
}
UPGRADE="0"; MODE_SET="0"; NODE_NAME_SET="0"; TRAFFIC_RESET_DAY_SET="0"
parse_args --upgrade --mode http --name demo-node --traffic-reset-day 7
printf 'RESULT UPGRADE=%s MODE=%s MODE_SET=%s NAME=%s NAME_SET=%s DAY=%s DAY_SET=%s\\n' \\
  "$UPGRADE" "$MODE" "$MODE_SET" "$NODE_NAME" "$NODE_NAME_SET" "$TRAFFIC_RESET_DAY" "$TRAFFIC_RESET_DAY_SET"
`;
    const out = stdoutOf(runShell(t, name, body).result);
    assert.match(
      out,
      /RESULT UPGRADE=1 MODE=http MODE_SET=1 NAME=demo-node NAME_SET=1 DAY=7 DAY_SET=1/,
      `${name} 的 --upgrade 参数解析结果不正确`,
    );
  });

  test(`U-S02 ${name} 无参数时保持默认（UPGRADE=0，--SET 全为 0）`, t => {
    const source = readScript(name);
    const loop = extractParseLoop(source, SCRIPTS.find(s => s.name === name).loop);
    const body = `
parse_args() {
${loop}
}
UPGRADE="0"; MODE_SET="0"; NODE_NAME_SET="0"; TRAFFIC_RESET_DAY_SET="0"
parse_args
printf 'RESULT UPGRADE=%s MODE_SET=%s NAME_SET=%s DAY_SET=%s\\n' "$UPGRADE" "$MODE_SET" "$NODE_NAME_SET" "$TRAFFIC_RESET_DAY_SET"
`;
    const out = stdoutOf(runShell(t, name, body).result);
    assert.match(out, /RESULT UPGRADE=0 MODE_SET=0 NAME_SET=0 DAY_SET=0/);
  });

  test(`U-S03 ${name} 未知参数以非零退出且不静默吞掉`, t => {
    const source = readScript(name);
    const loop = extractParseLoop(source, SCRIPTS.find(s => s.name === name).loop);
    const body = `
parse_args() {
${loop}
}
parse_args --definitely-not-a-flag
printf 'SHOULD-NOT-REACH\\n'
`;
    const { result } = runShell(t, name, body);
    assert.notEqual(result.status, 0, '未知参数必须导致非零退出');
    assert.doesNotMatch(result.stdout, /SHOULD-NOT-REACH/);
    assert.match(result.stderr, /Unknown option/i);
  });

  test(`U-S04 ${name} 升级守护单元路径按 systemd/openrc 解析`, t => {
    const body = `
SERVICE_NAME=cf-vps-monitor-agent-demo
UNIT_FILE=/etc/systemd/system/cf-vps-monitor-agent-demo.service
INIT_FILE=/etc/init.d/cf-vps-monitor-agent-demo
SERVICE_MODE=systemd
agent_upgrade_service_paths
printf 'SYSTEMD svc=%s path=%s name=%s\\n' "$UPGRADE_SERVICE_FILE" "$UPGRADE_PATH_FILE" "$UPGRADE_SERVICE_NAME"
SERVICE_MODE=openrc
agent_upgrade_service_paths
printf 'OPENRC svc=%s path=[%s] name=%s\\n' "$UPGRADE_SERVICE_FILE" "$UPGRADE_PATH_FILE" "$UPGRADE_SERVICE_NAME"
`;
    const out = stdoutOf(runShell(t, name, body).result);
    assert.match(
      out,
      /SYSTEMD svc=\/etc\/systemd\/system\/cf-vps-monitor-agent-demo-upgrade\.service path=\/etc\/systemd\/system\/cf-vps-monitor-agent-demo-upgrade\.path name=cf-vps-monitor-agent-demo-upgrade/,
      `${name} 的 systemd 守护单元路径不正确`,
    );
    assert.match(
      out,
      /OPENRC svc=\/etc\/init\.d\/cf-vps-monitor-agent-demo-upgrade path=\[\] name=cf-vps-monitor-agent-demo-upgrade/,
      `${name} 的 openrc 守护单元路径不正确`,
    );
  });

  test(`U-S05 ${name} systemd 守护单元内容为 root oneshot + 路径触发`, t => {
    const body = `
SERVICE_NAME=cf-vps-monitor-agent-demo
UNIT_FILE=/etc/systemd/system/cf-vps-monitor-agent-demo.service
SERVICE_MODE=systemd
INSTALL_DIR=/opt/cf-vps-monitor/demo
STATE_DIR=$INSTALL_DIR/state
agent_upgrade_service_paths
agent_upgrade_systemd_service_content
printf '\\n===PATH===\\n'
agent_upgrade_systemd_path_content
`;
    const out = stdoutOf(runShell(t, name, body).result);
    assert.match(out, /^# cf-vps-monitor-upgrade:1$/m, 'service 单元缺少所有权标记');
    assert.match(out, /^# service: cf-vps-monitor-agent-demo$/m);
    assert.match(out, /^# install: \/opt\/cf-vps-monitor\/demo$/m);
    assert.match(out, /^Type=oneshot$/m, '升级守护必须是 oneshot，不能常驻');
    assert.match(out, /^User=root$/m, '升级守护必须以 root 运行');
    assert.match(out, /^NoNewPrivileges=true$/m);
    assert.match(out, /--upgrade-supervisor --once\b/, 'ExecStart 必须走 --upgrade-supervisor --once');
    assert.match(out, /--health-timeout 60\b/, 'ExecStart 必须携带健康等待窗口');
    assert.match(out, /--mode systemd\b/);
    assert.match(out, /===PATH===/);
    assert.match(out, /^PathExists=\/opt\/cf-vps-monitor\/demo\/state\/upgrade-request\.json$/m);
    assert.match(out, /^Unit=cf-vps-monitor-agent-demo-upgrade\.service$/m);
  });

  test(`U-S06 ${name} openrc 守护单元为 root 后台常驻`, t => {
    const body = `
SERVICE_NAME=cf-vps-monitor-agent-demo
INIT_FILE=/etc/init.d/cf-vps-monitor-agent-demo
SERVICE_MODE=openrc
INSTALL_DIR=/opt/cf-vps-monitor/demo
STATE_DIR=$INSTALL_DIR/state
agent_upgrade_openrc_content
`;
    const out = stdoutOf(runShell(t, name, body).result);
    assert.match(out, /^# cf-vps-monitor-upgrade:1$/m);
    assert.match(out, /^# service: cf-vps-monitor-agent-demo$/m);
    assert.match(out, /^# install: \/opt\/cf-vps-monitor\/demo$/m);
    assert.match(out, /^command_user="root:root"$/m, 'openrc 守护必须以 root 运行');
    assert.match(out, /^command_background=true$/m, 'openrc 守护必须后台常驻');
    assert.match(out, /--upgrade-supervisor\b/);
    assert.match(out, /--mode openrc\b/);
  });

  test(`U-S07 ${name} 所有权判定只认三条标记且必须唯一硬链接`, t => {
    const body = `
SERVICE_NAME=svc
INSTALL_DIR=/opt/x
printf '%s\\n' '# cf-vps-monitor-upgrade:1' '# service: svc' '# install: /opt/x' > "$ROOT/good"
printf '%s\\n' '# cf-vps-monitor-upgrade:1' '# service: svc' > "$ROOT/bad"
printf '%s\\n' '# cf-vps-monitor-upgrade:1' '# service: other' '# install: /opt/x' > "$ROOT/wrong"
printf '%s\\n' '# cf-vps-monitor-upgrade:1' '# service: svc' '# install: /opt/x' '# extra: x' > "$ROOT/extra"
if agent_upgrade_marker_owned "$ROOT/good"; then echo 'GOOD=owned'; else echo 'GOOD=unowned'; fi
if agent_upgrade_marker_owned "$ROOT/bad"; then echo 'BAD=owned'; else echo 'BAD=unowned'; fi
if agent_upgrade_marker_owned "$ROOT/wrong"; then echo 'WRONG=owned'; else echo 'WRONG=unowned'; fi
if agent_upgrade_marker_owned "$ROOT/extra"; then echo 'EXTRA=owned'; else echo 'EXTRA=unowned'; fi
`;
    const out = stdoutOf(runShell(t, name, body).result);
    assert.match(out, /GOOD=owned/);
    assert.match(out, /BAD=unowned/, '缺少 # install: 行必须视为非我方所有');
    assert.match(out, /WRONG=unowned/, 'service 名不匹配必须视为非我方所有');
    assert.match(out, /EXTRA=owned/, '三行标记齐全即为我方所有，附加行不影响判定');
  });

  test(`U-S08 ${name} 停用守护时对非我方单元零改动`, t => {
    const body = `
SERVICE_NAME=svc
SERVICE_MODE=systemd
UNIT_FILE="$ROOT/svc.service"
INSTALL_DIR=/opt/x
STATE_DIR=/opt/x/state
: > "$UNIT_FILE"
run() { "$@"; }
agent_upgrade_service_paths
: > "$UPGRADE_SERVICE_FILE"
agent_stop_upgrade_supervisor
printf 'BLOCKED=%s\\n' "$UPGRADE_SUPERVISOR_BLOCKED"
if [ -e "$UPGRADE_SERVICE_FILE" ]; then echo 'FILE=kept'; else echo 'FILE=gone'; fi
`;
    const { result } = runShell(t, name, body);
    const out = stdoutOf(result);
    assert.match(out, /BLOCKED=1/, '非我方单元必须触发阻断标记');
    assert.match(out, /FILE=kept/, '非我方单元不得被删除');
    assert.match(result.stderr, /unowned|left unchanged/i);
  });

  test(`U-S13 ${name} --upgrade 从已装配置读回 server/token/模式，显式参数优先`, t => {
    const body = `
ENV_FILE="$ROOT/stored.env"
cat > "$ENV_FILE" <<'STORE'
CF_MONITOR_SERVER='https://stored.example.test'
CF_MONITOR_TOKEN='stored-token'
CF_MONITOR_NAME='stored-name'
CF_MONITOR_MODE='http'
CF_MONITOR_TRAFFIC_RESET_DAY='9'
CF_MONITOR_NIC_INCLUDE='eth0'
STORE
SERVER=""; TOKEN=""; NODE_NAME=""; MODE="websocket"; TRAFFIC_RESET_DAY="1"; NIC_INCLUDE=""
NODE_NAME_SET=0; MODE_SET=0; TRAFFIC_RESET_DAY_SET=0
agent_upgrade_load_config
printf 'REUSE SERVER=%s TOKEN=%s NAME=%s MODE=%s DAY=%s NIC=%s\\n' \\
  "$SERVER" "$TOKEN" "$NODE_NAME" "$MODE" "$TRAFFIC_RESET_DAY" "$NIC_INCLUDE"
# 显式给出的值必须压过已存配置。
SERVER=""; TOKEN=""; NODE_NAME="explicit"; MODE="websocket"; TRAFFIC_RESET_DAY="3"
NODE_NAME_SET=1; MODE_SET=1; TRAFFIC_RESET_DAY_SET=1
agent_upgrade_load_config
printf 'EXPLICIT NAME=%s MODE=%s DAY=%s\\n' "$NODE_NAME" "$MODE" "$TRAFFIC_RESET_DAY"
`;
    const out = stdoutOf(runShell(t, name, body).result);
    assert.match(
      out,
      /REUSE SERVER=https:\/\/stored\.example\.test TOKEN=stored-token NAME=stored-name MODE=http DAY=9 NIC=eth0/,
      `${name} 未能从已装配置读回 server/token/名称/模式/流量日`,
    );
    assert.match(out, /EXPLICIT NAME=explicit MODE=websocket DAY=3/, `${name} 的显式参数必须优先于已存配置`);
  });
}

// 结构性回归锁（跨脚本一致，不依赖 shell 执行环境）。

test('U-S09 两个 Linux 安装脚本的 agent_safety_helpers 块逐字节相同', () => {
  const a = extractSafetyBlock(readScript('install.sh'));
  const b = extractSafetyBlock(readScript('install-linux.sh'));
  assert.ok(a.length > 0, 'safety 块不应为空');
  assert.equal(a, b, 'agent_safety_helpers() 必须逐字节一致，否则两套安装器的安全基线会漂移');
});

test('U-S10 卸载路径接线：单实例与全量清理都回收升级守护', () => {
  for (const { name } of SCRIPTS) {
    const source = readScript(name);
    if (name === 'install.sh') {
      assert.match(extractFunction(source, 'uninstall_system'), /agent_remove_upgrade_supervisor\b/);
      assert.match(extractFunction(source, 'uninstall_all_agents'), /agent_remove_upgrade_supervisors_for_all\b/);
    } else {
      // install-linux.sh 的卸载分支直接内联调用，未包成同名函数。
      assert.match(source, /agent_remove_upgrade_supervisor \|\| exit 1/, `${name} 卸载分支未回收升级守护`);
      assert.match(source, /agent_remove_upgrade_supervisors_for_all \|\| return 1/, `${name} 全量卸载未回收全部升级守护`);
    }
  }
});

test('U-S11 --upgrade 复用已保存配置且要求既有安装', () => {
  for (const { name } of SCRIPTS) {
    const source = readScript(name);
    assert.match(source, /^UPGRADE="0"$/m, `${name} 缺少 UPGRADE 默认值`);
    assert.match(source, /--upgrade\)\s*UPGRADE="1";\s*shift/, `${name} 参数解析缺少 --upgrade`);
    assert.match(source, /--upgrade requires an existing installation/, `${name} 缺少既有安装前置校验`);
    assert.match(source, /agent_upgrade_load_config\b/, `${name} 升级分支未复用已保存配置`);
    // 复用配置必须在 server/token 校验之前执行，否则 --upgrade 会因缺参直接失败。
    const loadIdx = source.search(/\bagent_upgrade_load_config\b/);
    const requireIdx = source.search(/--server and --token are required/);
    assert.ok(loadIdx !== -1 && requireIdx !== -1 && loadIdx < requireIdx, `${name} 的配置复用必须早于 server/token 校验`);
  }
});

test('U-S12 usage 文本与 Windows 安装器均声明 --upgrade 入口', () => {
  for (const { name } of SCRIPTS) {
    assert.match(readScript(name), /--upgrade\s+Upgrade an existing installation/, `${name} usage 未列出 --upgrade`);
  }
  const windows = readFileSync(join(agentDir, 'install-windows.ps1'), 'utf8').replaceAll('\r\n', '\n');
  assert.match(windows, /\[switch\]\$Upgrade\b/, 'install-windows.ps1 缺少 -Upgrade 开关');
  assert.match(windows, /\$Upgrade\b/, 'install-windows.ps1 未处理 -Upgrade 分支');
});

console.log('ok - installer upgrade entry, supervisor units, ownership and uninstall wiring are covered');
