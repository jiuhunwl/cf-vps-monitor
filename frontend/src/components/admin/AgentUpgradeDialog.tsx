/**
 * 节点一键升级确认 / 进度弹窗。
 *
 * 职责边界：所有版本比较、分波编排、状态映射都来自 utils/agentUpgrade.ts 的纯函数，
 * 本组件只负责渲染、把 `useApi()` 注入 API 层，并在卸载 / 关闭时清理轮询定时器。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Box, Button, Checkbox, Dialog, Flex, Separator, Text } from '@radix-ui/themes';
import { ArrowUpCircle, Info, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '../../contexts/AuthContext';
import {
  AgentUpgradeCommand,
  DEFAULT_UPGRADE_BATCH_SIZE,
  DEFAULT_UPGRADE_POLL_INTERVAL_MS,
  UpgradeTargetNode,
  createAgentUpgrade,
  describeSkipReason,
  describeUpgradeFailure,
  fetchUpgradeRelease,
  fetchUpgradeStatus,
  isAgentDowngrade,
  mergeUpgradeCommands,
  normalizeAgentVersion,
  partitionUpgradeTargets,
  planBatches,
  pollUpgradeStatus,
  runUpgradeWaves,
  upgradeStatusDisplay,
} from '../../utils/agentUpgrade';
import AgentUpgradeStatusBadge from './AgentUpgradeStatusBadge';

export interface AgentUpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodes: UpgradeTargetNode[];
  /** 已固化的目标版本；为 null 时本弹窗会自行拉取 `/release`。 */
  targetVersion: string | null;
  /** 弹窗自行解析出目标版本后回传，便于父组件缓存并驱动「已最新置灰」。 */
  onResolvedTarget?: (version: string | null) => void;
  /** 升级波次推进结束后回调（父组件据此刷新节点列表）。 */
  onFinished?: () => void;
}

function UpgradeNodeRow({
  node,
  targetVersion,
  command,
  onRetry,
  busy,
}: {
  node: UpgradeTargetNode;
  targetVersion: string | null;
  command?: AgentUpgradeCommand;
  onRetry: (uuid: string) => void;
  busy: boolean;
}) {
  const current = normalizeAgentVersion(node.version) || '未知版本';
  const target = normalizeAgentVersion(targetVersion) || '最新版本';
  const downgrade = isAgentDowngrade(node.version, targetVersion);
  const display = command ? upgradeStatusDisplay(command.status) : upgradeStatusDisplay('idle');

  return (
    <Flex align="center" justify="between" gap="3" className="agent-upgrade-row">
      <Flex direction="column" style={{ minWidth: 0 }}>
        <Flex align="center" gap="2">
          <Text size="2" weight="medium" truncate>{node.name || node.uuid}</Text>
          {downgrade && <Badge size="1" variant="soft" color="orange">降级</Badge>}
        </Flex>
        <Text size="1" color="gray">
          {current} → {target}
        </Text>
        {command?.failure_code && display.retryable && (
          <Text size="1" color="red">
            {describeUpgradeFailure({ failure_code: command.failure_code, failure_reason: command.failure_reason, from_version: command.from_version ?? node.version })}
          </Text>
        )}
      </Flex>
      <Flex align="center" gap="2" style={{ flexShrink: 0 }}>
        <AgentUpgradeStatusBadge
          status={command ? command.status : 'idle'}
          failureCode={command?.failure_code}
          failureReason={command?.failure_reason}
          fromVersion={command?.from_version ?? node.version}
        />
        {display.retryable && (
          <Button size="1" variant="soft" disabled={busy} onClick={() => onRetry(node.uuid)}>
            <RotateCw size={13} /> 重试
          </Button>
        )}
      </Flex>
    </Flex>
  );
}

export default function AgentUpgradeDialog({
  open,
  onOpenChange,
  nodes,
  targetVersion,
  onResolvedTarget,
  onFinished,
}: AgentUpgradeDialogProps) {
  const apiFetch = useApi();

  const [resolvedTarget, setResolvedTarget] = useState<string | null>(targetVersion);
  const [releaseLoading, setReleaseLoading] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [commands, setCommands] = useState<Record<string, AgentUpgradeCommand>>({});
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [batchCurrent, setBatchCurrent] = useState(0);
  const [downgradeConfirmed, setDowngradeConfirmed] = useState(false);

  const cancelledRef = useRef(false);
  const timersRef = useRef<Map<number, () => void>>(new Map());
  const onResolvedTargetRef = useRef(onResolvedTarget);
  const onFinishedRef = useRef(onFinished);

  useEffect(() => { onResolvedTargetRef.current = onResolvedTarget; }, [onResolvedTarget]);
  useEffect(() => { onFinishedRef.current = onFinished; }, [onFinished]);

  /** 可取消的 sleep：注册定时器句柄，取消时 clearTimeout 并 resolve，绝不泄漏定时器。 */
  const sleep = useCallback((ms: number) => new Promise<void>((resolve) => {
    const id = window.setTimeout(() => {
      timersRef.current.delete(id);
      resolve();
    }, ms);
    timersRef.current.set(id, () => {
      window.clearTimeout(id);
      resolve();
    });
  }), []);

  const cancelPolling = useCallback(() => {
    cancelledRef.current = true;
    for (const abort of timersRef.current.values()) abort();
    timersRef.current.clear();
  }, []);

  useEffect(() => () => cancelPolling(), [cancelPolling]);

  // 打开弹窗时重置状态；若父组件尚未提供目标版本则自行拉取。
  useEffect(() => {
    if (!open) return;
    cancelledRef.current = false;
    timersRef.current.clear();
    setCommands({});
    setRunning(false);
    setStarted(false);
    setBatchCurrent(0);
    setDowngradeConfirmed(false);
    setReleaseError(null);
    setResolvedTarget(targetVersion ?? null);
    if (targetVersion) return;

    let cancelled = false;
    setReleaseLoading(true);
    fetchUpgradeRelease(apiFetch)
      .then((release) => {
        if (cancelled) return;
        setResolvedTarget(release.latest_version);
        onResolvedTargetRef.current?.(release.latest_version);
        if (!release.latest_version) setReleaseError('暂时无法获取最新版本，请稍后再试');
      })
      .catch((error) => {
        if (!cancelled) setReleaseError(error instanceof Error ? error.message : '获取最新版本失败');
      })
      .finally(() => {
        if (!cancelled) setReleaseLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, targetVersion, apiFetch]);

  const partition = useMemo(() => partitionUpgradeTargets(nodes, resolvedTarget), [nodes, resolvedTarget]);
  const batchPlan = useMemo(
    () => planBatches(partition.toUpgrade, { batchSize: DEFAULT_UPGRADE_BATCH_SIZE }),
    [partition.toUpgrade],
  );
  const hasDowngrade = partition.downgrades.length > 0;

  const mergeCommands = useCallback((incoming: AgentUpgradeCommand[]) => {
    setCommands((prev) => mergeUpgradeCommands(prev, incoming));
  }, []);

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) cancelPolling();
    onOpenChange(next);
  }, [cancelPolling, onOpenChange]);

  const startUpgrade = useCallback(async () => {
    const target = resolvedTarget;
    if (!target || running) return;
    const uuids = partition.toUpgrade.map((node) => node.uuid);
    if (uuids.length === 0) {
      toast.error('所选节点均已是最新版本，无需升级');
      return;
    }
    if (hasDowngrade && !downgradeConfirmed) {
      toast.error('存在降级节点，请先确认降级操作');
      return;
    }

    cancelledRef.current = false;
    setRunning(true);
    setStarted(true);
    setBatchCurrent(0);

    try {
      await runUpgradeWaves({
        batches: planBatches(uuids, { batchSize: DEFAULT_UPGRADE_BATCH_SIZE }),
        intervalMs: DEFAULT_UPGRADE_POLL_INTERVAL_MS,
        isCancelled: () => cancelledRef.current,
        dispatch: async (batch) => {
          const result = await createAgentUpgrade(apiFetch, batch, target);
          for (const skipped of result.skipped) {
            toast.message(`${skipped.client_uuid.slice(0, 8)} 已跳过：${describeSkipReason(skipped.reason)}`);
          }
          return result.commands;
        },
        fetchStatus: (ids) => fetchUpgradeStatus(apiFetch, ids),
        sleep,
        onBatchStart: (index) => setBatchCurrent(index + 1),
        onCommands: mergeCommands,
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : '波次下发失败');
        },
      });
      if (!cancelledRef.current) {
        toast.success('升级指令已全部下发完成');
        onFinishedRef.current?.();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '升级下发失败');
    } finally {
      setRunning(false);
    }
  }, [apiFetch, downgradeConfirmed, hasDowngrade, mergeCommands, partition.toUpgrade, resolvedTarget, running, sleep]);

  const retryNode = useCallback(async (uuid: string) => {
    const target = resolvedTarget;
    if (!target || running) return;
    try {
      const result = await createAgentUpgrade(apiFetch, [uuid], target);
      mergeCommands(result.commands);
      const ids = result.commands.map((command) => command.id).filter(Boolean);
      await pollUpgradeStatus({
        ids,
        fetchStatus: (value) => fetchUpgradeStatus(apiFetch, value),
        sleep,
        intervalMs: DEFAULT_UPGRADE_POLL_INTERVAL_MS,
        isCancelled: () => cancelledRef.current,
        onCommands: mergeCommands,
      });
      onFinishedRef.current?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重试失败');
    }
  }, [apiFetch, mergeCommands, resolvedTarget, running, sleep]);

  const canStart = Boolean(resolvedTarget) && partition.toUpgrade.length > 0 && !running && (!hasDowngrade || downgradeConfirmed);
  const targetLabel = resolvedTarget ? normalizeAgentVersion(resolvedTarget) : releaseLoading ? '正在获取…' : '未知';

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Content className="admin-node-dialog agent-upgrade-dialog" style={{ maxWidth: 660 }}>
        <Dialog.Title>升级节点 Agent</Dialog.Title>
        <Dialog.Description size="2" mb="2">
          目标版本：{targetLabel}
        </Dialog.Description>

        {releaseError && (
          <Flex align="center" gap="2" mb="2">
            <Info size={14} />
            <Text size="2" color="red">{releaseError}</Text>
          </Flex>
        )}

        <div className="admin-node-dialog-scroll">
          <Flex align="center" gap="2" mb="2" wrap="wrap">
            <Badge size="2" variant="soft" color="blue">将升级 {partition.toUpgrade.length}</Badge>
            <Badge size="2" variant="soft" color="gray">已最新跳过 {partition.skipped.length}</Badge>
            <Text size="1" color="gray">每批 {DEFAULT_UPGRADE_BATCH_SIZE} 个串行推进</Text>
          </Flex>

          {hasDowngrade && !started && (
            <Box mb="2" p="2" className="agent-upgrade-downgrade-warning">
              <Text size="2" color="orange" weight="bold">
                检测到 {partition.downgrades.length} 个节点将被降级（目标版本低于当前版本）
              </Text>
              <Text as="p" size="1" color="gray" mt="1">
                降级会替换为更旧的二进制，可能丢失新版本修复的问题。确认后才会继续：
              </Text>
              <Flex align="center" gap="2" mt="2">
                <Checkbox checked={downgradeConfirmed} onCheckedChange={(value) => setDowngradeConfirmed(value === true)} />
                <Text size="2">我确认要对上述节点执行降级</Text>
              </Flex>
            </Box>
          )}

          {partition.toUpgrade.length > 0 && (
            <Box mb="2">
              <Flex align="center" justify="between" mb="2">
                <Text size="2" weight="bold">
                  {started ? '升级进度' : '将升级的节点'}
                </Text>
                {started && (
                  <Text size="1" color="gray">
                    第 {Math.max(batchCurrent, 1)} / {batchPlan.length} 批
                  </Text>
                )}
              </Flex>
              {batchPlan.map((batch, index) => (
                <Box key={index} mb="2" className="agent-upgrade-batch">
                  {batchPlan.length > 1 && (
                    <Text size="1" color="gray" style={{ display: 'block', marginBottom: 4 }}>
                      第 {index + 1} 批 · {batch.length} 个
                    </Text>
                  )}
                  <Flex direction="column" gap="1">
                    {batch.map((node) => (
                      <UpgradeNodeRow
                        key={node.uuid}
                        node={node}
                        targetVersion={resolvedTarget}
                        command={commands[node.uuid]}
                        onRetry={retryNode}
                        busy={running}
                      />
                    ))}
                  </Flex>
                </Box>
              ))}
            </Box>
          )}

          {partition.skipped.length > 0 && (
            <>
              <Separator size="4" mb="2" />
              <Text size="2" weight="bold">已是最新版本（将跳过）</Text>
              <Flex direction="column" gap="1" mt="1">
                {partition.skipped.map((node) => (
                  <Flex key={node.uuid} align="center" justify="between" gap="3">
                    <Text size="2" truncate>{node.name || node.uuid}</Text>
                    <Text size="1" color="gray">{normalizeAgentVersion(node.version)}</Text>
                  </Flex>
                ))}
              </Flex>
            </>
          )}
        </div>

        <Flex justify="end" gap="2" mt="3">
          {running
            ? <Button color="red" variant="soft" onClick={() => handleOpenChange(false)}>停止并关闭</Button>
            : <Button variant="soft" onClick={() => handleOpenChange(false)}>关闭</Button>}
          <Button onClick={startUpgrade} disabled={!canStart}>
            <ArrowUpCircle size={14} />
            {started ? '重新下发' : `确认升级（${partition.toUpgrade.length}）`}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
