import { CF_MONITOR_BRANCH, CF_MONITOR_REPOSITORY } from './projectLinks';

export type AgentInstallPlatform = 'unix' | 'windows';

export type AgentInstallOptions = {
  ghproxy: string;
  downloadProxy: string;
  installMode: 'auto' | 'system' | 'user';
  dir: string;
  serviceName: string;
  binaryUrl?: string;
  checksumUrl?: string;
  releaseTag?: string;
  scriptRef?: string;
  trafficResetDay: string;
  mountInclude: string;
  mountExclude: string;
  nicInclude: string;
  nicExclude: string;
};

export const defaultAgentInstallOptions: AgentInstallOptions = {
  ghproxy: '',
  downloadProxy: '',
  installMode: 'auto',
  dir: '',
  serviceName: '',
  binaryUrl: '',
  checksumUrl: '',
  releaseTag: '',
  scriptRef: '',
  trafficResetDay: '1',
  mountInclude: '',
  mountExclude: '',
  nicInclude: '',
  nicExclude: '',
};

// 分支与仓库标识的权威定义在 projectLinks.ts，这里只转出以兼容既有引用。
export { CF_MONITOR_BRANCH };
export const CF_MONITOR_AGENT_SCRIPT_REF = `refs/heads/${CF_MONITOR_BRANCH}`;
export const CF_MONITOR_RELEASE_BASE = `https://github.com/${CF_MONITOR_REPOSITORY}/releases/latest/download`;
export const CF_MONITOR_AGENT_SCRIPT_BASE = `https://raw.githubusercontent.com/${CF_MONITOR_REPOSITORY}/${CF_MONITOR_AGENT_SCRIPT_REF}/agent`;

function isLocalHttpHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}
function serverUrlOrigin(value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if ((url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHttpHost(url.hostname))) && !url.username && !url.password && url.hostname) {
      return url.origin;
    }
  } catch {
    return '';
  }
  return '';
}

export function normalizeServerUrl(value: string, fallback: string) {
  return serverUrlOrigin(value) || serverUrlOrigin(fallback) || 'https://localhost';
}

function httpsDownloadUrl(value?: string | null) {
  const raw = value?.trim() || '';
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && !url.username && !url.password && url.hostname) {
      return url.toString();
    }
  } catch {
    return '';
  }
  return '';
}

function customAgentDownloadUrls(binaryValue?: string | null, checksumValue?: string | null) {
  const binaryUrl = httpsDownloadUrl(binaryValue);
  const checksumUrl = binaryUrl ? httpsDownloadUrl(checksumValue) : '';
  return binaryUrl && checksumUrl ? { binaryUrl, checksumUrl } : { binaryUrl: '', checksumUrl: '' };
}

function normalizeReleaseTag(value?: string | null) {
  const raw = value?.trim() || '';
  return /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(raw) ? raw : '';
}

export function normalizeProxyUrl(value: string, allowPath = true) {
  const raw = value.trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && url.hostname && !url.search && !url.hash) {
      const path = allowPath && url.pathname !== '/' ? url.pathname.replace(/\/+$/g, '') : '';
      return `${url.origin}${path}`;
    }
  } catch {
    return '';
  }
  return '';
}

export const GITHUB_PROXY_PRESETS = [
  'https://gh-proxy.org',
  'https://v4.gh-proxy.org',
  'https://v6.gh-proxy.org',
  'https://cdn.gh-proxy.org',
  'https://axisnow.gh-proxy.org',
] as const;

/** A content mirror is not an HTTP CONNECT proxy: downloads must stay HTTPS. */
export function normalizeGitHubProxyUrl(value: string) {
  const raw = value.trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(value) || /\s/.test(raw)) return '';
  const withScheme = raw.includes('://') ? raw : `https://${raw}`;
  const proxy = normalizeProxyUrl(withScheme);
  return proxy.startsWith('https://') ? proxy : '';
}
export function proxiedUrl(url: string, ghproxy = '') {
  const proxy = normalizeGitHubProxyUrl(ghproxy);
  if (!proxy) return url;
  return `${proxy}/${url}`;
}

function normalizeScriptRef(scriptRef?: string | null) {
  const match = scriptRef?.trim().match(/^[a-f0-9]{7,40}$/i);
  return match ? match[0].toLowerCase() : CF_MONITOR_AGENT_SCRIPT_REF;
}

export function cfMonitorAgentScriptRefFromRevision(revision?: string | null) {
  const scriptRef = normalizeScriptRef(revision);
  return scriptRef === CF_MONITOR_AGENT_SCRIPT_REF ? '' : scriptRef;
}

export function cfMonitorAgentScriptUrl(
  scriptFile: 'install.sh' | 'install-linux.sh' | 'install-windows.ps1',
  ghproxy = '',
  releaseTag = '',
  scriptRef = '',
) {
  const ref = normalizeScriptRef(scriptRef);
  const tag = normalizeReleaseTag(releaseTag);
  const base = tag
      ? `https://github.com/${CF_MONITOR_REPOSITORY}/releases/download/${tag}`
      : `https://raw.githubusercontent.com/${CF_MONITOR_REPOSITORY}/${ref}/agent`;
  return proxiedUrl(`${base}/${scriptFile}`, ghproxy);
}

export function cfMonitorAgentBinaryUrl(platform: AgentInstallPlatform, ghproxy = '') {
  const file = platform === 'windows'
    ? 'cf-vps-monitor-agent-windows-amd64.exe'
    : 'cf-vps-monitor-agent-linux-amd64';
  return proxiedUrl(`${CF_MONITOR_RELEASE_BASE}/${file}`, ghproxy);
}

function shellQuote(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function psQuote(value: string) {
  return "'" + value.replace(/'/g, "''") + "'";
}

function powershellCommand(script: string): string {
  let bytes = '';
  for (let index = 0; index < script.length; index += 1) {
    const codeUnit = script.charCodeAt(index);
    bytes += String.fromCharCode(codeUnit & 0xff, codeUnit >>> 8);
  }
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${btoa(bytes)}`;
}

function normalizeTrafficResetDay(value: string) {
  const day = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(day)) return '1';
  return String(Math.min(31, Math.max(1, day)));
}

function normalizeInstanceId(value?: string) {
  const cleaned = (value || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (cleaned || 'default').slice(0, 48);
}

function shPipe(downloadCommand: string, args: string[]) {
  return `${downloadCommand} | sh -s -- ${args.map(shellQuote).join(' ')}`;
}

export function buildAgentInstallCommand({
  platform,
  serverUrl,
  token,
  options,
  instanceId,
  nodeName,
}: {
  platform: AgentInstallPlatform;
  serverUrl: string;
  token: string;
  options: AgentInstallOptions;
  instanceId?: string;
  nodeName?: string;
}) {
  const ghproxy = normalizeGitHubProxyUrl(options.ghproxy);
  if (/[\u0000-\u001f\u007f]/.test(options.ghproxy) || (options.ghproxy.trim() && !ghproxy)) return '';
  const downloadProxy = normalizeProxyUrl(options.downloadProxy, false);
  const { binaryUrl, checksumUrl } = customAgentDownloadUrls(options.binaryUrl, options.checksumUrl);
  const releaseTag = normalizeReleaseTag(options.releaseTag);
  const scriptRef = options.scriptRef?.trim();
  const installMode = ['system', 'user'].includes(options.installMode) ? options.installMode : '';
  const dir = options.dir.trim();
  const serviceName = options.serviceName.trim();
  const effectiveInstanceId = normalizeInstanceId(instanceId || nodeName);
  const effectiveNodeName = nodeName?.trim();
  const mountInclude = options.mountInclude.trim();
  const mountExclude = options.mountExclude.trim();
  const nicInclude = options.nicInclude.trim();
  const nicExclude = options.nicExclude.trim();
  const trafficResetDay = normalizeTrafficResetDay(options.trafficResetDay);

  switch (platform) {
    case 'unix': {
      const args = ['-s', serverUrl, '-t', token || '<TOKEN>'];
      if (trafficResetDay !== '1') args.push('-r', trafficResetDay);
      if (effectiveNodeName) args.push('-n', effectiveNodeName);
      args.push('-i', effectiveInstanceId);
      if (installMode) args.push('--install-mode', installMode);
      if (binaryUrl) args.push('--binary-url', binaryUrl);
      if (checksumUrl) args.push('--checksum-url', checksumUrl);
      if (releaseTag && !binaryUrl) args.push('--release-tag', releaseTag);
      if (ghproxy) args.push('--install-ghproxy', ghproxy);
      if (downloadProxy) args.push('--proxy', downloadProxy);
      if (dir) args.push('--install-dir', dir);
      if (serviceName) args.push('--service-name', serviceName);
      if (mountInclude) args.push('--mount-include', mountInclude);
      if (mountExclude) args.push('--mount-exclude', mountExclude);
      if (nicInclude) args.push('--nic-include', nicInclude);
      if (nicExclude) args.push('--nic-exclude', nicExclude);
      return shPipe(
        `wget -qO- ${shellQuote(cfMonitorAgentScriptUrl('install.sh', ghproxy, releaseTag, scriptRef))}`,
        args,
      );
    }
    case 'windows': {
      const args = ['-s', serverUrl, '-t', token || '<TOKEN>'];
      if (trafficResetDay !== '1') args.push('-r', trafficResetDay);
      if (effectiveNodeName) args.push('-n', effectiveNodeName);
      args.push('-i', effectiveInstanceId);
      if (binaryUrl) args.push('-BinaryUrl', binaryUrl);
      if (checksumUrl) args.push('-ChecksumUrl', checksumUrl);
      if (releaseTag && !binaryUrl) args.push('-ReleaseTag', releaseTag);
      if (ghproxy) args.push('-InstallGhproxy', ghproxy);
      if (downloadProxy) args.push('-Proxy', downloadProxy);
      if (dir) args.push('-InstallDir', dir);
      if (serviceName) args.push('-ServiceName', serviceName);
      if (mountInclude) args.push('-MountInclude', mountInclude);
      if (mountExclude) args.push('-MountExclude', mountExclude);
      if (nicInclude) args.push('-NicInclude', nicInclude);
      if (nicExclude) args.push('-NicExclude', nicExclude);
      return powershellCommand(
        `iwr ${psQuote(cfMonitorAgentScriptUrl('install-windows.ps1', ghproxy, releaseTag, scriptRef))} -UseBasicParsing -OutFile 'install-windows.ps1'; & '.\\install-windows.ps1' ${args.map((arg, index) => index % 2 === 0 ? arg : psQuote(arg)).join(' ')}`,
      );
    }
    default:
      return '';
  }
}
export function buildAgentUninstallAllCommand({
  platform,
  ghproxy = '',
  scriptRef = '',
}: {
  platform: AgentInstallPlatform;
  serverUrl?: string;
  ghproxy?: string;
  scriptRef?: string;
}) {
  const proxy = normalizeGitHubProxyUrl(ghproxy);
  if (/[\u0000-\u001f\u007f]/.test(ghproxy) || (ghproxy.trim() && !proxy)) return '';
  const scriptUrl = (file: 'install.sh' | 'install-windows.ps1') =>
    cfMonitorAgentScriptUrl(file, proxy, '', scriptRef);
  switch (platform) {
    case 'windows':
      return powershellCommand(
        `iwr ${psQuote(scriptUrl('install-windows.ps1'))} -UseBasicParsing -OutFile 'install-windows.ps1'; & '.\\install-windows.ps1' -UninstallAll -Yes`,
      );
    case 'unix':
    default:
      return shPipe(
        `wget -qO- ${shellQuote(scriptUrl('install.sh'))}`,
        ['--uninstall-all', '--yes', ...(proxy ? ['--install-ghproxy', proxy] : [])],
      );
  }
}

export type AgentManualUpgradeOptions = {
  ghproxy: string;
  downloadProxy: string;
  installMode: 'auto' | 'system' | 'user';
  instanceId: string;
  dir: string;
  serviceName: string;
  releaseTag: string;
};

export const defaultAgentManualUpgradeOptions: AgentManualUpgradeOptions = {
  ghproxy: '', downloadProxy: '', installMode: 'auto', instanceId: '',
  dir: '', serviceName: '', releaseTag: '',
};

/** Bootstrap with the current installer, never by asking the old Agent to upgrade itself. */
export function buildAgentManualUpgradeCommand({ platform, options, scriptRef = '' }: {
  platform: AgentInstallPlatform;
  options: AgentManualUpgradeOptions;
  scriptRef?: string;
}): string {
  const values = [options.ghproxy, options.downloadProxy, options.instanceId, options.dir, options.serviceName, options.releaseTag];
  if (values.some(value => /[\u0000-\u001f\u007f]/.test(value))) return '';
  const ghproxy = normalizeGitHubProxyUrl(options.ghproxy);
  const downloadProxy = normalizeProxyUrl(options.downloadProxy, false);
  if ((options.ghproxy.trim() && !ghproxy) || (options.downloadProxy.trim() && !downloadProxy)) return '';
  const rawTag = options.releaseTag.trim();
  const releaseTag = rawTag.toLowerCase() === 'latest' ? '' : normalizeReleaseTag(rawTag);
  if (rawTag && rawTag.toLowerCase() !== 'latest' && !releaseTag) return '';
  const instanceId = options.instanceId.trim().toLowerCase();
  if (instanceId && !/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(instanceId)) return '';
  const dir = options.dir.trim();
  const serviceName = options.serviceName.trim();
  if (!['auto', 'system', 'user'].includes(options.installMode)) return '';
  if (serviceName && (serviceName.startsWith('-') || ['.', '..'].includes(serviceName)
    || (platform === 'unix' ? !/^[A-Za-z0-9_.@-]+$/.test(serviceName) : /[\\/*?\[\]]/.test(serviceName)))) return '';

  // The bootstrap script must be new enough to understand --upgrade/-Upgrade.
  // ReleaseTag selects the binary, not an old installer bundled with that release.
  const scriptUrl = cfMonitorAgentScriptUrl(platform === 'windows' ? 'install-windows.ps1' : 'install.sh', ghproxy, '', scriptRef);
  const curlArgs = ['--fail', '--silent', '--show-error', '--location', '--proto', '=https',
    '--proto-redir', '=https', '--connect-timeout', '15', '--max-time', '120'];
  if (downloadProxy) curlArgs.push('--proxy', downloadProxy);
  curlArgs.push(scriptUrl);

  if (platform === 'unix') {
    const args = ['--upgrade'];
    if (releaseTag) args.push('--release-tag', releaseTag);
    if (instanceId) args.push('--instance-id', instanceId);
    if (options.installMode !== 'auto') args.push('--install-mode', options.installMode);
    if (ghproxy) args.push('--install-ghproxy', ghproxy);
    if (downloadProxy) args.push('--proxy', downloadProxy);
    if (dir) args.push('--install-dir', dir);
    if (serviceName) args.push('--service-name', serviceName);
    const script = [
      'set -eu',
      'command -v curl >/dev/null 2>&1 || { printf "%s\\n" "curl is required for HTTPS-only bootstrap" >&2; exit 1; }',
      'installer=$(mktemp "${TMPDIR:-/tmp}/cf-vps-upgrade.XXXXXXXX")',
      'trap \'rm -f -- "$installer"\' 0',
      'trap \'exit 1\' HUP INT TERM',
      `curl ${curlArgs.map(shellQuote).join(' ')} --output "$installer"`,
      `sh "$installer" ${args.map(shellQuote).join(' ')}`,
    ].join('\n');
    return `sh -c ${shellQuote(script)}`;
  }

  if (platform === 'windows') {
    const args = ['-Upgrade'];
    const add = (flag: string, value: string) => { if (value) args.push(flag, psQuote(value)); };
    add('-ReleaseTag', releaseTag);
    add('-InstanceId', instanceId);
    add('-InstallGhproxy', ghproxy);
    add('-Proxy', downloadProxy);
    add('-InstallDir', dir);
    add('-ServiceName', serviceName);
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$curl = (Get-Command curl.exe -CommandType Application -ErrorAction Stop).Source",
      "$work = Join-Path ([IO.Path]::GetTempPath()) ('cf-vps-upgrade-' + [Guid]::NewGuid().ToString('N'))",
      '[void][IO.Directory]::CreateDirectory($work)',
      "$installer = Join-Path $work 'install-windows.ps1'",
      'try {',
      `  & $curl ${curlArgs.map(psQuote).join(' ')} --output $installer`,
      "  if ($LASTEXITCODE -ne 0) { throw 'HTTPS installer download failed; nothing was executed.' }",
      `  & (Join-Path $PSHOME 'powershell.exe') -NoProfile -ExecutionPolicy Bypass -File $installer ${args.join(' ')}`,
      "  if ($LASTEXITCODE -ne 0) { throw 'Agent installer reported failure.' }",
      '} finally {',
      "  if (Test-Path -LiteralPath $installer -PathType Leaf) { Remove-Item -LiteralPath $installer -Force }",
      '  try { [IO.Directory]::Delete($work) } catch { Write-Warning "Temporary directory retained: $work" }',
      '}',
    ].join('\n');
    return powershellCommand(script);
  }
  return '';
}
