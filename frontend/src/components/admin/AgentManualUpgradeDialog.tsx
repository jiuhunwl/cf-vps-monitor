import { useId, useState } from 'react';
import { Box, Button, Checkbox, Dialog, Flex, SegmentedControl, Select, Text, TextField } from '@radix-ui/themes';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import {
  AgentInstallPlatform,
  AgentManualUpgradeOptions,
  buildAgentManualUpgradeCommand,
  defaultAgentManualUpgradeOptions,
} from '../../utils/agentInstallCommand';
import { isAgentDowngrade, normalizeAgentVersion } from '../../utils/agentUpgrade';
import GitHubProxyInput from './GitHubProxyInput';

// Deliberately excludes token, connection URL and the panel UUID (not necessarily an instance ID).
export interface AgentManualUpgradeTarget {
  name: string;
  version?: string | null;
  os?: string;
  targetVersion: string | null;
}

function ManualField({ label, value, onChange, placeholder, helper }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  helper?: string;
}) {
  const id = useId();
  return (
    <Box style={{ minWidth: 0 }}>
      <label htmlFor={id}>
        <Text size="2" weight="bold" style={{ display: 'block', marginBottom: 4 }}>{label}</Text>
      </label>
      <TextField.Root id={id} value={value} onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder} autoComplete="off" spellCheck={false}
        aria-describedby={helper ? `${id}-help` : undefined} style={{ width: '100%' }} />
      {helper && <Text as="p" id={`${id}-help`} size="1" color="gray" mt="1">{helper}</Text>}
    </Box>
  );
}

/** Mounted afresh for each opening; background release refreshes must not overwrite user input. */
export default function AgentManualUpgradeDialog({ target, onClose }: {
  target: AgentManualUpgradeTarget;
  onClose: () => void;
}) {
  const [platform, setPlatform] = useState<AgentInstallPlatform>(() => /windows/i.test(target.os || '') ? 'windows' : 'unix');
  const [options, setOptions] = useState<AgentManualUpgradeOptions>(() => ({
    ...defaultAgentManualUpgradeOptions,
    releaseTag: target.targetVersion || '',
  }));
  const [downgradeConfirmed, setDowngradeConfirmed] = useState(false);
  const setOption = <K extends keyof AgentManualUpgradeOptions>(key: K, value: AgentManualUpgradeOptions[K]) => {
    if (key === 'releaseTag') setDowngradeConfirmed(false);
    setOptions((previous) => ({ ...previous, [key]: value }));
  };
  const command = buildAgentManualUpgradeCommand({ platform, options });
  const tag = options.releaseTag.trim();
  const downgrade = Boolean(command && tag && tag.toLowerCase() !== 'latest' && isAgentDowngrade(target.version, tag));
  const canCopy = Boolean(command) && (!downgrade || downgradeConfirmed);
  const copyCommand = async () => {
    if (!canCopy) return;
    try {
      await navigator.clipboard.writeText(command);
      toast.success('手动升级命令已复制，请到目标服务器执行；复制不会开始升级');
    } catch {
      toast.error('复制失败，请手动选中下方命令复制');
    }
  };

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Content className="admin-command-dialog" style={{ maxWidth: 740, maxHeight: '90dvh', display: 'flex', flexDirection: 'column' }}>
        <Dialog.Title>手动升级 Agent</Dialog.Title>
        <Dialog.Description size="2" mb="2">
          节点：{target.name} · 当前版本：{normalizeAgentVersion(target.version) || '未知'}
        </Dialog.Description>
        <SegmentedControl.Root value={platform} onValueChange={(value) => setPlatform(value as AgentInstallPlatform)} style={{ marginBottom: 12 }}>
          <SegmentedControl.Item value="unix">Unix 自动检测</SegmentedControl.Item>
          <SegmentedControl.Item value="windows">Windows</SegmentedControl.Item>
        </SegmentedControl.Root>

        <Flex className="admin-command-options-scroll" direction="column" gap="3" style={{ minHeight: 0 }}>
          <Box>
            <Text as="p" size="2">适用于不支持远程升级的旧 Agent。下载新版安装器并读取本机保存的连接配置，不申请或重置 Token。</Text>
            <Text as="p" size="1" color="gray" mt="1">
              {platform === 'windows'
                ? '请在目标服务器的管理员 PowerShell 中执行；需要 curl.exe。'
                : '请在目标服务器执行；系统服务使用 root，用户模式使用原安装用户，并选择原安装模式。需要 curl。'}
              升级会替换二进制并重启 Agent；找不到原安装或配置时会停止。请先备份原配置，自定义参数需核对。
            </Text>
          </Box>
          <div className="install-options-grid">
            <ManualField label="目标 Release Tag" value={options.releaseTag} onChange={(value) => setOption('releaseTag', value)}
              placeholder="例如 v2.0.4；留空或 latest 使用最新发布版"
              helper="安装器使用当前仓库代码，目标二进制必须已发布到 GitHub Release；更新 Cloudflare 不会发布 Agent。" />
            <GitHubProxyInput value={options.ghproxy} onChange={(value) => setOption('ghproxy', value)} />
            <ManualField label="下载代理" value={options.downloadProxy} onChange={(value) => setOption('downloadProxy', value)}
              placeholder="可选，例如 http://127.0.0.1:10808" helper="HTTP CONNECT 代理，与 GitHub 内容加速地址不同。" />
            {platform === 'unix' && (
              <label>
                <Text size="2" weight="bold" style={{ display: 'block', marginBottom: 4 }}>原安装模式</Text>
                <Select.Root value={options.installMode} onValueChange={(value) => setOption('installMode', value as AgentManualUpgradeOptions['installMode'])}>
                  <Select.Trigger style={{ width: '100%' }} aria-label="原安装模式" />
                  <Select.Content>
                    <Select.Item value="auto">自动选择</Select.Item>
                    <Select.Item value="system">系统服务（root）</Select.Item>
                    <Select.Item value="user">用户模式（原用户）</Select.Item>
                  </Select.Content>
                </Select.Root>
              </label>
            )}
            <ManualField label="原实例 ID" value={options.instanceId} onChange={(value) => setOption('instanceId', value)}
              placeholder="留空使用旧版默认实例"
              helper="多实例请填写原安装命令中的 -i / --instance-id / -InstanceId，不会自动套用节点 UUID。" />
            <ManualField label="原安装目录" value={options.dir} onChange={(value) => setOption('dir', value)}
              placeholder={platform === 'windows' ? '默认目录留空；自定义时填原 Windows 路径' : '默认目录留空；自定义时填原绝对路径'} />
            <ManualField label="原服务名称" value={options.serviceName} onChange={(value) => setOption('serviceName', value)}
              placeholder="默认名称留空；自定义时必须与原安装一致" />
          </div>
          <Text as="p" size="1" color="orange">
            手动升级不会撤销已下发的远程任务。请先确认任务状态，并与待执行任务保持相同目标版本，避免重复升级；有任务正在执行时请先等待其结束。
          </Text>
          {downgrade && (
            <Box p="2" className="agent-upgrade-downgrade-warning">
              <Text as="p" size="2" color="orange">目标版本低于当前版本，降级可能丢失安全修复。</Text>
              <Flex asChild align="center" gap="2" mt="2">
                <label>
                  <Checkbox checked={downgradeConfirmed} onCheckedChange={(value) => setDowngradeConfirmed(value === true)} />
                  <Text size="2">我确认要生成降级命令</Text>
                </label>
              </Flex>
            </Box>
          )}
          {!command && <Text as="p" size="2" color="red" role="alert">无法生成命令：请检查代理地址、版本格式、实例 ID、路径或服务名称，不能包含控制字符。</Text>}
        </Flex>

        <Box className="admin-command-code" tabIndex={0} aria-label="手动升级命令" style={{ whiteSpace: 'pre-wrap', maxHeight: 160, flexShrink: 0 }}><code>{command || '请先修正上方选项。'}</code></Box>
        <Flex justify="end" gap="2" mt="3" wrap="wrap">
          <Button variant="soft" onClick={onClose}>关闭</Button>
          <Button onClick={copyCommand} disabled={!canCopy}><Copy size={14} /> 复制手动升级命令</Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
