import { useId } from 'react';
import { Box, Text, TextField } from '@radix-ui/themes';
import { GITHUB_PROXY_PRESETS, normalizeGitHubProxyUrl } from '../../utils/agentInstallCommand';

export default function GitHubProxyInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  const inputId = `github-proxy-${id}`;
  const listId = `${inputId}-presets`;
  const helpId = `${inputId}-help`;
  const invalid = /[\u0000-\u001f\u007f]/.test(value) || (Boolean(value.trim()) && !normalizeGitHubProxyUrl(value));

  return (
    <Box style={{ minWidth: 0 }}>
      <label htmlFor={inputId}>
        <Text size="2" weight="bold" style={{ display: 'block', marginBottom: 4 }}>GitHub 代理</Text>
      </label>
      <TextField.Root
        id={inputId}
        list={listId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="留空为直连，也可选择或输入 HTTPS 代理"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        aria-describedby={helpId}
        style={{ width: '100%' }}
      />
      <datalist id={listId}>
        {GITHUB_PROXY_PRESETS.map((proxy) => <option key={proxy} value={proxy} />)}
      </datalist>
      <Text as="p" id={helpId} size="1" color={invalid ? 'red' : 'gray'} mt="1" aria-live="polite">
        {invalid
          ? '请输入 HTTPS 地址，不允许账号密码、查询参数、片段或控制字符。'
          : '留空为直连；支持预设和自定义地址。第三方代理可修改下载内容，请仅使用可信代理。'}
      </Text>
    </Box>
  );
}
