/**
 * 面板「节点一键升级」纯逻辑层。
 *
 * 设计原则（与 agentInstallCommand.ts 一致）：把可测的业务逻辑全部收敛到本文件的
 * 纯函数 / 依赖注入函数里，React 组件只负责渲染与把 `useApi()` 注进来。
 *
 * 本文件**不 import 任何运行时依赖**（React / api.ts 皆不引入），因此可以被
 * `node --test` 直接用类型擦除方式加载（见 agentUpgrade.test.mjs）。
 */

/* ==========================================================================
 * 1. 类型（与 worker/src/db/types.ts 的 AgentUpgradeCommand 逐字一致）
 * ========================================================================== */

export type AgentUpgradeCommandStatus =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'success'
  | 'already_latest'
  | 'failed'
  | 'rolled_back'
  | 'unverified';

export interface AgentUpgradeCommand {
  id: string;
  client_uuid: string;
  target_version: string;
  requested_by: string;
  status: AgentUpgradeCommandStatus;
  from_version: string | null;
  final_version: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  created_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export type AgentUpgradeSkipReason =
  | 'already_latest'
  | 'already_pending'
  | 'not_found'
  | 'invalid_target';

export interface AgentUpgradeSkipped {
  client_uuid: string;
  reason: AgentUpgradeSkipReason;
}

export interface CreateAgentUpgradeResponse {
  success: true;
  target_version: string;
  created: number;
  skipped: AgentUpgradeSkipped[];
  commands: AgentUpgradeCommand[];
}

export interface AgentUpgradeStatusResponse {
  success: true;
  commands: AgentUpgradeCommand[];
}

export interface AgentUpgradeReleaseResponse {
  success: true;
  latest_version: string | null;
  published_at: string | null;
  cached?: boolean;
}

/** 面板侧参与升级编排所需的最小节点视图（AdminClient 结构上兼容）。 */
export interface UpgradeTargetNode {
  uuid: string;
  name?: string;
  version?: string | null;
}

/** 注入的 API 传输层，签名与 contexts/AuthContext.tsx 的 `useApi()` 返回值一致。 */
export type ApiFetchFn = (path: string, options?: RequestInit) => Promise<any>;

/* ==========================================================================
 * 2. 常量
 * ========================================================================== */

export const DEFAULT_UPGRADE_BATCH_SIZE = 5;
export const DEFAULT_UPGRADE_POLL_INTERVAL_MS = 2000;

export const AGENT_UPGRADE_CREATE_PATH = '/admin/agents/upgrade';
export const AGENT_UPGRADE_STATUS_PATH = '/admin/agents/upgrade/status';
export const AGENT_UPGRADE_RELEASE_PATH = '/admin/agents/upgrade/release';

/* ==========================================================================
 * 3. 版本规范化与比较
 * ========================================================================== */

/**
 * 归一化 Agent 版本号：统一成带 `v` 前缀的 SemVer 形态。
 * 注意：本函数含 `v1.0.2` → `v1.0.2`、`1.0.2` → `v1.0.2` 的映射，
 * 因此**任何版本比较前，两侧都必须先经过本函数**，否则 `v1.0.2` 与 `1.0.2`
 * 会被当作不同版本。
 *
 * （原为 Dashboard.tsx 内的局部函数，抽到此处以建立单一事实来源。）
 */
export function normalizeAgentVersion(version?: string | null): string {
  const value = version?.trim();
  if (!value) return '';
  const semver = value.match(/v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?/i)?.[0];
  if (semver) return /^v/i.test(semver) ? semver : `v${semver}`;
  if (/^v/i.test(value) || !/^\d/.test(value)) return value;
  return `v${value}`;
}

interface ParsedAgentVersion {
  core: [number, number, number];
  pre: string;
}

function parseAgentVersion(version?: string | null): ParsedAgentVersion | null {
  const match = normalizeAgentVersion(version).match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] || '',
  };
}

/**
 * 比较两个 Agent 版本：a < b 返回 -1，a === b 返回 0，a > b 返回 1。
 * 无法解析为 SemVer 时退化为规范化字符串比较（保证结果稳定、不抛异常）。
 */
export function compareAgentVersions(a?: string | null, b?: string | null): number {
  const pa = parseAgentVersion(a);
  const pb = parseAgentVersion(b);
  if (!pa || !pb) {
    const na = normalizeAgentVersion(a);
    const nb = normalizeAgentVersion(b);
    if (na === nb) return 0;
    return na < nb ? -1 : 1;
  }
  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // 正式版 > 预发布版
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** 节点是否已经是最新版本（两侧均规范化后比较）。 */
export function isAgentUpToDate(currentVersion?: string | null, targetVersion?: string | null): boolean {
  const current = normalizeAgentVersion(currentVersion);
  const target = normalizeAgentVersion(targetVersion);
  return current !== '' && target !== '' && current === target;
}

/** 目标版本是否低于节点当前版本（即「降级」）。 */
export function isAgentDowngrade(currentVersion?: string | null, targetVersion?: string | null): boolean {
  const current = normalizeAgentVersion(currentVersion);
  const target = normalizeAgentVersion(targetVersion);
  if (current === '' || target === '' || current === target) return false;
  return compareAgentVersions(target, current) < 0;
}

/** `target_version` 入参是否为「取最新」语义（缺省或 'latest'）。 */
export function isLatestTargetToken(target?: string | null): boolean {
  const value = (target || '').trim().toLowerCase();
  return value === '' || value === 'latest';
}

/* ==========================================================================
 * 4. 预分组：将升级 / 已最新跳过 / 降级
 * ========================================================================== */

export interface UpgradePartition<T extends UpgradeTargetNode> {
  /** 需要升级的节点（不含已最新）。 */
  toUpgrade: T[];
  /** 已是最新版本、将被跳过的节点。 */
  skipped: T[];
  /** 属于 toUpgrade 中、目标版本低于当前版本的节点（需二次确认）。 */
  downgrades: T[];
}

/**
 * 按目标版本把节点分成「将升级 / 已最新跳过」两组，并单独标出降级节点。
 * 目标版本为空或节点版本未知时一律视为「将升级」（无法判定即交给后端/节点判断）。
 */
export function partitionUpgradeTargets<T extends UpgradeTargetNode>(
  nodes: T[],
  targetVersion?: string | null,
): UpgradePartition<T> {
  const toUpgrade: T[] = [];
  const skipped: T[] = [];
  const downgrades: T[] = [];
  for (const node of nodes) {
    if (isAgentUpToDate(node.version, targetVersion)) {
      skipped.push(node);
      continue;
    }
    toUpgrade.push(node);
    if (isAgentDowngrade(node.version, targetVersion)) downgrades.push(node);
  }
  return { toUpgrade, skipped, downgrades };
}

/** 计算给定节点中「将升级」的数量（已最新不计入），用于批量按钮计数。 */
export function countUpgradableTargets(
  nodes: UpgradeTargetNode[],
  targetVersion?: string | null,
): number {
  return partitionUpgradeTargets(nodes, targetVersion).toUpgrade.length;
}

/* ==========================================================================
 * 5. 分波编排
 * ========================================================================== */

/**
 * 把目标按 `batchSize`（默认 5）切成若干批；批内并行、批间串行由调用方驱动。
 * 空数组 → 空批次列表。
 */
export function planBatches<T>(items: T[], options: { batchSize?: number } = {}): T[][] {
  const requested = options.batchSize ?? DEFAULT_UPGRADE_BATCH_SIZE;
  const size = Math.max(1, Math.floor(Number.isFinite(requested) ? requested : DEFAULT_UPGRADE_BATCH_SIZE));
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/* ==========================================================================
 * 6. 状态机
 * ========================================================================== */

/** 面板侧 UI 阶段（比后端命令状态多出 confirm/dispatch 两个本地阶段）。 */
export type UpgradeUiPhase =
  | 'idle'
  | 'confirming'
  | 'dispatching'
  | 'queued'
  | 'running'
  | 'success'
  | 'already_latest'
  | 'failed'
  | 'rolled_back'
  | 'unverified';

export type UpgradeTransitionEvent =
  | 'confirm'
  | 'cancel'
  | 'dispatch'
  | 'queued'
  | 'start'
  | 'success'
  | 'already_latest'
  | 'fail'
  | 'rollback'
  | 'unverify'
  | 'retry';

/**
 * 状态机迁移表：
 * `idle → confirming → dispatching → queued → running → { 终态 }`；
 * `failed / rolled_back → (retry) → dispatching`。
 */
export const UPGRADE_PHASE_TRANSITIONS: Record<
  UpgradeUiPhase,
  Partial<Record<UpgradeTransitionEvent, UpgradeUiPhase>>
> = {
  idle: { confirm: 'confirming' },
  confirming: { cancel: 'idle', dispatch: 'dispatching' },
  dispatching: { queued: 'queued', fail: 'failed' },
  queued: {
    start: 'running',
    success: 'success',
    already_latest: 'already_latest',
    fail: 'failed',
    rollback: 'rolled_back',
    unverify: 'unverified',
  },
  running: {
    success: 'success',
    already_latest: 'already_latest',
    fail: 'failed',
    rollback: 'rolled_back',
    unverify: 'unverified',
  },
  success: {},
  already_latest: {},
  failed: { retry: 'dispatching' },
  rolled_back: { retry: 'dispatching' },
  unverified: {},
};

/** 应用一次事件，返回迁移后的阶段；非法迁移返回 null。 */
export function transitionUpgradePhase(
  phase: UpgradeUiPhase,
  event: UpgradeTransitionEvent,
): UpgradeUiPhase | null {
  return UPGRADE_PHASE_TRANSITIONS[phase]?.[event] ?? null;
}

/** 后端命令状态 → UI 阶段。 */
export function phaseFromCommandStatus(status: AgentUpgradeCommandStatus): UpgradeUiPhase {
  switch (status) {
    case 'queued':
    case 'dispatched':
      return 'queued';
    case 'running':
      return 'running';
    case 'success':
      return 'success';
    case 'already_latest':
      return 'already_latest';
    case 'failed':
      return 'failed';
    case 'rolled_back':
      return 'rolled_back';
    case 'unverified':
      return 'unverified';
    default:
      return 'idle';
  }
}

const PENDING_COMMAND_STATUSES: readonly AgentUpgradeCommandStatus[] = ['queued', 'dispatched', 'running'];

/** 命令是否处于未决（需要继续轮询）状态。 */
export function isPendingStatus(status: AgentUpgradeCommandStatus): boolean {
  return PENDING_COMMAND_STATUSES.includes(status);
}

/** 命令是否已达终态。 */
export function isTerminalStatus(status: AgentUpgradeCommandStatus): boolean {
  return !isPendingStatus(status);
}

/** 一批命令中是否仍有未决项（决定是否继续轮询）。 */
export function hasPendingCommands(commands: ReadonlyArray<Pick<AgentUpgradeCommand, 'status'>>): boolean {
  return commands.some((command) => isPendingStatus(command.status));
}

/** UI 阶段是否需要继续轮询。 */
export function isPendingUpgradePhase(phase: UpgradeUiPhase): boolean {
  return phase === 'dispatching' || phase === 'queued' || phase === 'running';
}

/** UI 阶段是否可重试（仅 failed / rolled_back）。 */
export function canRetryUpgradePhase(phase: UpgradeUiPhase): boolean {
  return phase === 'failed' || phase === 'rolled_back';
}

/* ==========================================================================
 * 7. 状态 → 展示映射（中文文案 + 语义色）
 * ========================================================================== */

export type UpgradeStatusColor =
  | 'gray'
  | 'blue'
  | 'green'
  | 'red'
  | 'orange'
  | 'amber';

export interface UpgradeStatusDisplay {
  /** 归入的 UI 阶段。 */
  phase: UpgradeUiPhase;
  /** 中文展示文案。 */
  label: string;
  /** 语义色（跟随 Radix Themes 主题 token）。 */
  color: UpgradeStatusColor;
  /** 是否仍需轮询。 */
  pending: boolean;
  /** 是否可重试。 */
  retryable: boolean;
}

type UpgradeDisplayKey = AgentUpgradeCommandStatus | UpgradeUiPhase;

const UPGRADE_STATUS_DISPLAY: Record<UpgradeDisplayKey, UpgradeStatusDisplay> = {
  // —— 后端命令状态 ——
  queued: { phase: 'queued', label: '排队中', color: 'blue', pending: true, retryable: false },
  dispatched: { phase: 'queued', label: '已下发，等待节点领取', color: 'blue', pending: true, retryable: false },
  running: { phase: 'running', label: '升级中', color: 'amber', pending: true, retryable: false },
  success: { phase: 'success', label: '升级成功', color: 'green', pending: false, retryable: false },
  already_latest: { phase: 'already_latest', label: '已是最新版本', color: 'gray', pending: false, retryable: false },
  failed: { phase: 'failed', label: '升级失败', color: 'red', pending: false, retryable: true },
  // rolled_back 与 unverified 的含义与「失败」完全不同，必须各自独立文案。
  rolled_back: { phase: 'rolled_back', label: '已回滚到升级前版本', color: 'orange', pending: false, retryable: true },
  unverified: { phase: 'unverified', label: '结果待核实（与目标版本不符）', color: 'amber', pending: false, retryable: false },
  // —— 仅面板侧存在的阶段 ——
  idle: { phase: 'idle', label: '待处理', color: 'gray', pending: false, retryable: false },
  confirming: { phase: 'confirming', label: '待确认', color: 'blue', pending: false, retryable: false },
  dispatching: { phase: 'dispatching', label: '下发中', color: 'blue', pending: true, retryable: false },
};

/** 取某个状态/阶段的中文文案与语义色。 */
export function upgradeStatusDisplay(status: UpgradeDisplayKey): UpgradeStatusDisplay {
  return UPGRADE_STATUS_DISPLAY[status] ?? UPGRADE_STATUS_DISPLAY.idle;
}

/* ==========================================================================
 * 8. 失败文案模板
 * ========================================================================== */

const UPGRADE_FAILURE_EXPLANATIONS: Record<string, string> = {
  checksum_mismatch: '校验和不匹配（下载的二进制与官方 SHA256SUMS 不一致）',
  download_failed: '下载新版本二进制失败',
  staging_failed: '准备升级文件失败（暂存阶段）',
  replace_failed: '替换二进制文件失败',
  restart_failed: '重启服务失败',
  health_timeout: '健康检查超时，新版本未在超时时间内就绪',
  rollback_failed: '回滚失败，节点可能未恢复正常运行',
  // 面板驱动的升级要求节点已安装带辅助单元的新版安装器；更老的节点必须先用脚本手工升级一次。
  unsupported_platform: '该节点需先手动执行一次安装脚本升级，之后才能被面板驱动',
  invalid_target: '目标版本无效',
  probe_failed: '健康探测失败',
  timeout: '升级超时未收到结果',
};

/** Go 侧 failure_code 全枚举（顺序稳定，便于测试与展示）。 */
export const UPGRADE_FAILURE_CODES: readonly string[] = Object.keys(UPGRADE_FAILURE_EXPLANATIONS);

/** 未知/缺失 failure_code 的兜底文案（绝不回显原始码，也绝不留空）。 */
export const UNKNOWN_UPGRADE_FAILURE = '升级过程中出现未知错误，请查看节点日志';

/** 失效后节点状态可能受影响的失败码（回滚/重启类）。 */
const UPGRADE_RESTART_RISK_CODES = new Set([
  'restart_failed',
  'health_timeout',
  'rollback_failed',
  'probe_failed',
]);

/**
 * 把 failure_code 翻译成人话。已知码走映射；未知码使用服务端可读原因，否则兜底文案。
 * **任何情况下都不会把原始 failure_code 直接回显给用户。**
 */
export function failureExplanation(code?: string | null, reason?: string | null): string {
  const key = (code || '').trim();
  if (key && UPGRADE_FAILURE_EXPLANATIONS[key]) return UPGRADE_FAILURE_EXPLANATIONS[key];
  const trimmedReason = (reason || '').trim();
  if (trimmedReason && trimmedReason !== key) return trimmedReason;
  return UNKNOWN_UPGRADE_FAILURE;
}

/**
 * 生成完整失败文案，形如：
 * 「升级失败：校验和不匹配；节点仍以 v1.4.2 正常运行」
 */
export function describeUpgradeFailure(command: {
  failure_code?: string | null;
  failure_reason?: string | null;
  from_version?: string | null;
}): string {
  const code = (command.failure_code || '').trim();
  const explanation = failureExplanation(command.failure_code, command.failure_reason);
  const from = normalizeAgentVersion(command.from_version);
  const base = `升级失败：${explanation}`;
  if (UPGRADE_RESTART_RISK_CODES.has(code)) {
    return from ? `${base}；请确认节点是否仍以 ${from} 正常运行` : `${base}；请确认节点服务状态`;
  }
  return from ? `${base}；节点仍以 ${from} 正常运行` : `${base}；节点当前版本未知，请手动确认`;
}

/** 跳过原因（skipped.reason）→ 中文文案。 */
export function describeSkipReason(reason: AgentUpgradeSkipReason): string {
  switch (reason) {
    case 'already_latest':
      return '已是最新版本';
    case 'already_pending':
      return '已有待执行的升级命令';
    case 'not_found':
      return '节点不存在';
    case 'invalid_target':
      return '目标版本无效';
    default:
      return '已跳过';
  }
}

/* ==========================================================================
 * 9. 状态合并
 * ========================================================================== */

/** 按 client_uuid 合并命令列表，后到的覆盖先到的（用于轮询增量更新）。 */
export function mergeUpgradeCommands(
  current: Record<string, AgentUpgradeCommand>,
  incoming: ReadonlyArray<AgentUpgradeCommand>,
): Record<string, AgentUpgradeCommand> {
  if (!incoming || incoming.length === 0) return current;
  const next = { ...current };
  for (const command of incoming) {
    if (command && typeof command.client_uuid === 'string' && command.client_uuid) {
      next[command.client_uuid] = command;
    }
  }
  return next;
}

/* ==========================================================================
 * 10. 轮询器与分波驱动（sleep / fetch 均可注入，便于测试与取消）
 * ========================================================================== */

export interface PollUpgradeStatusOptions {
  ids: string[];
  fetchStatus: (ids: string[]) => Promise<AgentUpgradeCommand[]>;
  sleep: (ms: number) => Promise<void>;
  intervalMs?: number;
  isCancelled?: () => boolean;
  onCommands?: (commands: AgentUpgradeCommand[]) => void;
}

/**
 * 轮询一批命令直到全部到达终态。
 * - **仅在存在未决命令时才继续轮询**（首轮若已全部终态则只请求一次）。
 * - `isCancelled()` 返回 true 或 `ids` 为空时立即停止。
 * - 返回最后一次拉取到的命令列表。
 */
export async function pollUpgradeStatus(options: PollUpgradeStatusOptions): Promise<AgentUpgradeCommand[]> {
  const {
    ids,
    fetchStatus,
    sleep,
    intervalMs = DEFAULT_UPGRADE_POLL_INTERVAL_MS,
    isCancelled = () => false,
    onCommands,
  } = options;
  let latest: AgentUpgradeCommand[] = [];
  if (ids.length === 0) return latest;
  while (!isCancelled()) {
    latest = await fetchStatus(ids);
    onCommands?.(latest);
    if (!hasPendingCommands(latest)) break;
    await sleep(intervalMs);
  }
  return latest;
}

export interface RunUpgradeWavesOptions {
  batches: string[][];
  /** 下发一批节点，返回新建的命令。 */
  dispatch: (uuids: string[]) => Promise<AgentUpgradeCommand[]>;
  fetchStatus: (ids: string[]) => Promise<AgentUpgradeCommand[]>;
  sleep: (ms: number) => Promise<void>;
  intervalMs?: number;
  isCancelled?: () => boolean;
  onBatchStart?: (index: number, uuids: string[]) => void;
  onCommands?: (commands: AgentUpgradeCommand[]) => void;
  onError?: (error: unknown, context: { batchIndex: number; uuids: string[] }) => void;
}

/**
 * 前端驱动的分波编排：逐批「下发 → 轮询至该批终态 → 下一批」。
 * **单批下发抛错或单个节点失败都不会阻塞后续波次**（P1-1 硬要求）。
 */
export async function runUpgradeWaves(options: RunUpgradeWavesOptions): Promise<void> {
  const {
    batches,
    dispatch,
    fetchStatus,
    sleep,
    intervalMs = DEFAULT_UPGRADE_POLL_INTERVAL_MS,
    isCancelled = () => false,
    onBatchStart,
    onCommands,
    onError,
  } = options;
  for (let index = 0; index < batches.length; index += 1) {
    if (isCancelled()) return;
    const uuids = batches[index];
    if (uuids.length === 0) continue;
    onBatchStart?.(index, uuids);
    let created: AgentUpgradeCommand[] = [];
    try {
      created = await dispatch(uuids);
    } catch (error) {
      // 一整批下发失败不影响其它波次，交由上层提示并继续。
      onError?.(error, { batchIndex: index, uuids });
      continue;
    }
    onCommands?.(created);
    const ids = created.map((command) => command.id).filter((id) => typeof id === 'string' && id !== '');
    await pollUpgradeStatus({ ids, fetchStatus, sleep, intervalMs, isCancelled, onCommands });
  }
}

/* ==========================================================================
 * 11. API 封装（均走注入的 apiFetch —— 它已处理 API_BASE 与 CSRF）
 * ========================================================================== */

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? (value as Record<string, any>) : {};
}

function assertSuccess(payload: any, fallbackMessage: string): void {
  if (!payload || payload.success !== true) {
    const message = payload && typeof payload.error === 'string' && payload.error
      ? payload.error
      : fallbackMessage;
    throw new Error(message);
  }
}

function normalizeCommands(raw: unknown): AgentUpgradeCommand[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is AgentUpgradeCommand =>
    Boolean(item) && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string',
  );
}

/** GET /admin/agents/upgrade/release —— 取最新发布版本（已固化的具体 tag）。 */
export async function fetchUpgradeRelease(apiFetch: ApiFetchFn): Promise<AgentUpgradeReleaseResponse> {
  const payload = asRecord(await apiFetch(AGENT_UPGRADE_RELEASE_PATH));
  assertSuccess(payload, '获取最新版本失败');
  const latest = typeof payload.latest_version === 'string' && payload.latest_version.trim()
    ? payload.latest_version.trim()
    : null;
  const publishedAt = typeof payload.published_at === 'string' && payload.published_at.trim()
    ? payload.published_at
    : null;
  return {
    success: true,
    latest_version: latest,
    published_at: publishedAt,
    cached: payload.cached === true,
  };
}

/** POST /admin/agents/upgrade —— 为一批节点创建升级命令。 */
export async function createAgentUpgrade(
  apiFetch: ApiFetchFn,
  uuids: string[],
  targetVersion?: string | null,
): Promise<CreateAgentUpgradeResponse> {
  const body: { uuids: string[]; target_version?: string } = { uuids };
  if (targetVersion && !isLatestTargetToken(targetVersion)) body.target_version = targetVersion;
  const payload = asRecord(await apiFetch(AGENT_UPGRADE_CREATE_PATH, {
    method: 'POST',
    body: JSON.stringify(body),
  }));
  assertSuccess(payload, '下发升级命令失败');
  const skipped = Array.isArray(payload.skipped)
    ? payload.skipped.filter((item: unknown): item is AgentUpgradeSkipped =>
        Boolean(item) && typeof item === 'object' && typeof (item as { client_uuid?: unknown }).client_uuid === 'string')
    : [];
  return {
    success: true,
    target_version: typeof payload.target_version === 'string' ? payload.target_version : '',
    created: typeof payload.created === 'number' ? payload.created : normalizeCommands(payload.commands).length,
    skipped,
    commands: normalizeCommands(payload.commands),
  };
}

/** GET /admin/agents/upgrade/status?ids=... —— 批量查询命令状态（不存在的 id 静默忽略）。 */
export async function fetchUpgradeStatus(
  apiFetch: ApiFetchFn,
  ids: string[],
): Promise<AgentUpgradeCommand[]> {
  const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id !== '')));
  if (unique.length === 0) return [];
  const query = encodeURIComponent(unique.join(','));
  const payload = asRecord(await apiFetch(`${AGENT_UPGRADE_STATUS_PATH}?ids=${query}`));
  assertSuccess(payload, '查询升级状态失败');
  return normalizeCommands(payload.commands);
}
