import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { productionModule } from '../../test/helpers/production-module.mjs';

const commands = productionModule('src/utils/agentInstallCommand.ts');
const { buildAgentManualUpgradeCommand, defaultAgentManualUpgradeOptions, normalizeGitHubProxyUrl, GITHUB_PROXY_PRESETS } = commands;
const options = extra => ({ ...defaultAgentManualUpgradeOptions, ...extra });

function decodePowerShell(command) {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)$/);
  assert.ok(match, 'the PowerShell command uses a complete encoded script');
  return Buffer.from(match[1], 'base64').toString('utf16le');
}

test('manual upgrade supports all supplied HTTPS accelerators and custom HTTPS prefixes', () => {
  assert.deepEqual(Array.from(GITHUB_PROXY_PRESETS), [
    'https://gh-proxy.org', 'https://v4.gh-proxy.org', 'https://v6.gh-proxy.org',
    'https://cdn.gh-proxy.org', 'https://axisnow.gh-proxy.org',
  ]);
  assert.equal(normalizeGitHubProxyUrl('mirror.example/gh/'), 'https://mirror.example/gh');
  for (const proxy of [...GITHUB_PROXY_PRESETS, 'https://mirror.example/gh']) {
    const command = buildAgentManualUpgradeCommand({ platform: 'unix', options: options({ ghproxy: proxy, releaseTag: 'v2.0.4' }) });
    assert.ok(command.includes(proxy + '/https://raw.githubusercontent.com/'));
    assert.ok(command.includes('/refs/heads/main/agent/install.sh'), 'bootstrap uses the new installer, not an old release installer');
  }
});

test('manual upgrade fails closed on insecure proxies, unsafe selectors and invalid versions', () => {
  for (const value of ['http://mirror.example', 'ftp://mirror.example', 'https://user:pass@mirror.example', 'https://mirror.example/?token=x', 'https://mirror.example/#x', 'https://mirror.example/\ncommand']) {
    assert.equal(normalizeGitHubProxyUrl(value), '');
    assert.equal(buildAgentManualUpgradeCommand({ platform: 'unix', options: options({ ghproxy: value }) }), '');
  }
  for (const extra of [{ releaseTag: 'v1.0.0; echo unsafe' }, { instanceId: '../another' }, { dir: '/tmp/bad\npath' }, { serviceName: '-other' }]) {
    assert.equal(buildAgentManualUpgradeCommand({ platform: 'unix', options: options(extra) }), '');
  }
});

test('the shared GitHub mirror validation also fails closed for install and uninstall commands', () => {
  for (const platform of ['unix', 'windows']) {
    for (const ghproxy of ['http://mirror.example', 'https://user:pass@mirror.example', 'https://mirror.example/?key=x', 'https://mirror.example\n', '\t']) {
      assert.equal(commands.normalizeGitHubProxyUrl(ghproxy), '');
      assert.equal(commands.buildAgentInstallCommand({ platform, serverUrl: 'https://panel.example', token: 'synthetic', options: { ...commands.defaultAgentInstallOptions, ghproxy } }), '');
      assert.equal(commands.buildAgentUninstallAllCommand({ platform, ghproxy }), '');
    }
  }
});

test('manual bootstrap defaults to direct access and the legacy default instance without new credentials', () => {
  for (const releaseTag of ['', 'latest']) {
    const unix = buildAgentManualUpgradeCommand({ platform: 'unix', options: options({ releaseTag }) });
    assert.ok(unix.includes('/refs/heads/main/agent/install.sh'));
    assert.ok(!unix.includes('--instance-id'));
    assert.ok(!unix.includes('--release-tag'));
    assert.ok(!unix.includes('gh-proxy.org'));
    assert.ok(!unix.includes('--server') && !unix.includes('--token'));
    const windows = decodePowerShell(buildAgentManualUpgradeCommand({ platform: 'windows', options: options({ releaseTag }) }));
    assert.ok(windows.includes('/refs/heads/main/agent/install-windows.ps1'));
    assert.ok(!windows.includes('-InstanceId'));
    assert.ok(!windows.includes('-ReleaseTag'));
    assert.ok(!windows.includes('-Server') && !windows.includes('-Token'));
  }
  const revision = 'a'.repeat(40);
  const pinned = buildAgentManualUpgradeCommand({ platform: 'unix', options: options({ releaseTag: 'v2.0.4' }), scriptRef: revision });
  assert.ok(pinned.includes('/' + revision + '/agent/install.sh'));
  assert.ok(pinned.includes('--release-tag'));
});

test('Windows manual upgrade preserves connection credentials and safely selects the existing instance', () => {
  const command = buildAgentManualUpgradeCommand({ platform: 'windows', options: options({
    ghproxy: GITHUB_PROXY_PRESETS[0], releaseTag: 'v2.0.4', instanceId: 'second',
    dir: "C:\\Program Files\\O'Reilly Agent", serviceName: 'My Agent',
  }), token: 'MUST_NOT_APPEAR', serverUrl: 'https://must-not-appear.example' });
  const script = decodePowerShell(command);
  assert.ok(script.includes('curl.exe'));
  assert.ok(script.includes('--proto-redir'));
  assert.ok(script.includes('=https'));
  assert.ok(script.includes('-Upgrade'));
  assert.ok(script.includes("-ReleaseTag 'v2.0.4'"));
  assert.ok(script.includes("-InstanceId 'second'"));
  assert.ok(script.includes("C:\\Program Files\\O''Reilly Agent"));
  assert.ok(script.includes('Remove-Item -LiteralPath'));
  assert.ok(!script.includes('-Recurse'));
  assert.ok(!script.includes('MUST_NOT_APPEAR') && !script.includes('must-not-appear.example'));
});

for (const scenario of ['success', 'download failure', 'installer failure']) {
  const failDownload = scenario === 'download failure';
  const failInstaller = scenario === 'installer failure';
  test('Unix manual upgrade only executes a completely downloaded installer: ' + scenario, { skip: process.platform === 'win32' }, t => {
    const base = realpathSync(tmpdir());
    const dir = mkdtempSync(join(base, 'cf-manual-upgrade-'));
    t.after(() => {
      const resolved = realpathSync(dir);
      assert.equal(dirname(resolved), base);
      assert.ok(basename(resolved).startsWith('cf-manual-upgrade-'));
      rmSync(resolved, { recursive: true });
    });
    const curl = join(dir, 'curl');
    writeFileSync(curl, `#!/bin/sh
printf '%s\\0' "$@" > "$CURL_ARGS"
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--output' ]; then output="$2"; shift 2; else shift; fi
done
cat > "$output" <<'INSTALLER'
#!/bin/sh
printf '%s\\0' "$@" > "$INSTALL_ARGS"
exit "$INSTALL_EXIT"
INSTALLER
[ "$FAIL_DOWNLOAD" = 1 ] && exit 22
exit 0
`);
    chmodSync(curl, 0o755);
    const installArgs = join(dir, 'installer.args');
    const curlArgs = join(dir, 'curl.args');
    const oldAgent = join(dir, 'cf-vps-monitor-agent');
    writeFileSync(oldAgent, '#!/bin/sh\nexit 99\n');
    chmodSync(oldAgent, 0o755);
    const installDir = "/opt/O'Reilly Agent; not-a-command";
    const command = buildAgentManualUpgradeCommand({ platform: 'unix', options: options({
      ghproxy: GITHUB_PROXY_PRESETS[0], downloadProxy: 'http://127.0.0.1:1080', releaseTag: 'v2.0.4',
      instanceId: 'second', dir: installDir, serviceName: 'cf-vps-second', installMode: 'system',
    }) });
    const result = spawnSync('/bin/sh', ['-c', command], { cwd: dir,
      env: { PATH: dir + ':/usr/bin:/bin', HOME: dir, TMPDIR: dir, CURL_ARGS: curlArgs, INSTALL_ARGS: installArgs, FAIL_DOWNLOAD: failDownload ? '1' : '0', INSTALL_EXIT: failInstaller ? '73' : '0' },
      encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, failDownload ? 22 : failInstaller ? 73 : 0, result.stderr);
    assert.equal(existsSync(installArgs), !failDownload, 'download failure must never execute a partial installer');
    if (!failDownload) {
      const args = readFileSync(installArgs, 'utf8').split('\0').filter(Boolean);
      assert.deepEqual(args, ['--upgrade', '--release-tag', 'v2.0.4', '--instance-id', 'second', '--install-mode', 'system',
        '--install-ghproxy', GITHUB_PROXY_PRESETS[0], '--proxy', 'http://127.0.0.1:1080', '--install-dir', installDir, '--service-name', 'cf-vps-second']);
    }
    const download = readFileSync(curlArgs, 'utf8').split('\0').filter(Boolean);
    assert.equal(download[download.indexOf('--proto') + 1], '=https');
    assert.equal(download[download.indexOf('--proto-redir') + 1], '=https');
    assert.equal(download[download.indexOf('--proxy') + 1], 'http://127.0.0.1:1080');
    assert.equal(existsSync(download[download.indexOf('--output') + 1]), false, 'private temporary installer is removed after success or failure');
  });
}
