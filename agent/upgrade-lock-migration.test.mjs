import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const available = spawnSync('sh', ['-c', 'exit 0'], { windowsHide: true }).status === 0;
function extract(source, name) {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `${name} must exist`);
  return match[0];
}
for (const name of ['install.sh', 'install-linux.sh']) {
  const source = readFileSync(new URL(name, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  for (const [kind, code, blocked] of [['stopped', 0, 0], ['failed', 1, 0], ['unowned', 0, 1]]) {
    test(`${name}: migration ${kind} state gates binary replacement`, { skip: !available }, () => {
      const helper = extract(source, 'agent_quiesce_upgrade_supervisor');
      const script = `${helper}\nagent_stop_upgrade_supervisor() { echo STOP; UPGRADE_SUPERVISOR_BLOCKED=${blocked}; return ${code}; }\nagent_quiesce_upgrade_supervisor || exit 1\necho REPLACE`;
      const result = spawnSync('sh', ['-c', script], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      assert.match(result.stdout, /STOP/);
      if (kind === 'stopped') {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /STOP\nREPLACE/);
      } else {
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(result.stdout, /REPLACE/);
      }
    });
  }
  test(`${name}: supported installation paths quiesce helpers before replacement`, () => {
    if (name === 'install.sh') {
      for (const fn of ['install_systemd', 'install_openrc']) {
        const body = extract(source, fn);
        const stop = body.indexOf('agent_quiesce_upgrade_supervisor || return 1');
        assert.ok(stop >= 0 && stop < body.indexOf('copy_binary_to'), `${fn} must stop before copying`);
      }
    } else {
      const stop = source.lastIndexOf('agent_quiesce_upgrade_supervisor || exit 1');
      const copy = source.indexOf('run install -m 0755 "$WORK_BIN"');
      assert.ok(stop >= 0 && stop < copy, 'Bash installer must stop before copying');
    }
    const stopBody = extract(source, 'agent_stop_upgrade_supervisor');
    assert.ok(stopBody.indexOf('disable --now "$(basename "$UPGRADE_PATH_FILE")"') < stopBody.indexOf('disable --now "$(basename "$UPGRADE_SERVICE_FILE")"'), 'systemd trigger must stop before helper');
  });
}
