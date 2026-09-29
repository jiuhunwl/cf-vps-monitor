/**
 * 升级命令状态徽章。
 *
 * 关键语义：`success` 的可信度依赖后端对「替换后新进程上报版本 == 目标版本」的交叉校验；
 * 上报版本与目标不符时后端会把命令降级为 `unverified`。因此 UI 上 `unverified` 必须
 * 显著区别于 `success`（文案与语义色都不同），`rolled_back` 亦独立于 `failed`。
 */
import { Badge } from '@radix-ui/themes';
import {
  AgentUpgradeCommandStatus,
  UpgradeUiPhase,
  describeUpgradeFailure,
  upgradeStatusDisplay,
} from '../../utils/agentUpgrade';

export interface AgentUpgradeStatusBadgeProps {
  status: AgentUpgradeCommandStatus | UpgradeUiPhase;
  failureCode?: string | null;
  failureReason?: string | null;
  fromVersion?: string | null;
  size?: '1' | '2' | '3';
}

export default function AgentUpgradeStatusBadge({
  status,
  failureCode,
  failureReason,
  fromVersion,
  size = '1',
}: AgentUpgradeStatusBadgeProps) {
  const display = upgradeStatusDisplay(status);
  const title = display.retryable
    ? describeUpgradeFailure({ failure_code: failureCode, failure_reason: failureReason, from_version: fromVersion })
    : display.label;

  return (
    <Badge size={size} variant="soft" color={display.color} title={title} className="agent-upgrade-status-badge">
      {display.label}
    </Badge>
  );
}
