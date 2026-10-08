import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
for (const [file, shell] of [['install.sh', 'sh'], ['install-linux.sh', 'bash']]) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const available = spawnSync(shell, ['-c', 'exit 0'], { windowsHide: true }).status === 0;
  function run(body) {
    const functions = ['normalize_proxy_url', 'require_https_url', 'with_github_proxy', 'download_file']
      .map(name => {
        const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
        assert.ok(match, `${file}: ${name} exists`);
        return match[0];
      }).join('\n');
    return spawnSync(shell, ['-c', `set -eu\n${functions}\ndie() { echo "$*" >&2; exit 1; }\nhas() { [ "$1" = curl ]; }\ncurl() { printf 'arg:%s\\n' "$@"; }\nDRY_RUN=0; PROXY=''; INSTALL_GHPROXY=''\n${body}`],
      { encoding: 'utf8', timeout: 5000, windowsHide: true });
  }
  test(`${file}: direct HTTP is rejected before downloader dispatch`, { skip: !available }, () => {
    const result = run('download_file http://mirror.example.test/binary ignored');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /https/i);
    assert.doesNotMatch(result.stdout, /arg:/);
  });
  test(`${file}: HTTP content mirror rejected before composing downloads`, { skip: !available }, () => {
    const result = run('INSTALL_GHPROXY=http://mirror.example.test; with_github_proxy https://github.com/example/repo');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /https/i);
  });
  test(`${file}: wget/fetch-only environment fails closed`, { skip: !available }, () => {
    const result = run(`has() { case "$1" in wget|fetch) return 0 ;; *) return 1 ;; esac; }
command() { case "$*" in '-v wget') return 0 ;; *) return 1 ;; esac; }
wget() { echo INSECURE_FALLBACK; }
fetch() { echo INSECURE_FALLBACK; }
download_file https://github.com/example/asset ignored`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /curl.*HTTPS/);
    assert.doesNotMatch(result.stdout, /INSECURE_FALLBACK/);
  });
  test(`${file}: protocol or certificate failure cannot trigger source fallback`, { skip: !available }, () => {
    const result = run(`curl() { return 1; }
if download_file https://github.com/example/asset ignored; then echo ACCEPTED; else echo SOURCE_FALLBACK; fi`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing fallback/);
    assert.doesNotMatch(result.stdout, /ACCEPTED|SOURCE_FALLBACK/);
  });
  test(`${file}: HTTPS mirror path and HTTP CONNECT proxy remain supported`, { skip: !available }, () => {
    const composed = run('INSTALL_GHPROXY=https://mirror.example.test/path; with_github_proxy https://github.com/example/repo');
    assert.equal(composed.status, 0, composed.stderr);
    assert.equal(composed.stdout, 'https://mirror.example.test/path/https://github.com/example/repo');
    const result = run(`PROXY=http://127.0.0.1:1080; download_file ${quote('https://github.com/example/asset')} ignored`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /arg:--proto\narg:=https/);
    assert.match(result.stdout, /arg:--proto-redir\narg:=https/);
    assert.match(result.stdout, /arg:--proxy\narg:http:\/\/127\.0\.0\.1:1080/);
  });
}

const windowsSource = readFileSync(new URL('install-windows.ps1', import.meta.url), 'utf8');
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const powershellAvailable = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true }).status === 0;
test('Windows: HTTP final URL rejected even during dry-run, HTTPS preview preserves proxy', { skip: !powershellAvailable }, () => {
  const functions = ['Assert-HttpsUrl', 'Invoke-DownloadFile'].map(name => {
    const match = windowsSource.match(new RegExp(`^function ${name} \\{[\\s\\S]*?^\\}`, 'm'));
    assert.ok(match);
    return match[0];
  }).join('\n');
  const script = `$ErrorActionPreference='Stop'\n${functions}\n$DryRun=$true; $Proxy='http://127.0.0.1:1080'\ntry { Invoke-DownloadFile -Url 'http://mirror.example.test/binary' -OutFile 'unused'; exit 7 } catch { if ($_.Exception.Message -notmatch 'https') { throw } }\nInvoke-DownloadFile -Url 'https://mirror.example.test/binary' -OutFile 'unused'`;
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /https:\/\/mirror\.example\.test\/binary/);
  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:1080/);
});
