#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const managedDeploy = join(root, 'scripts', 'deploy-cloudflare.mjs');
// npm 可能把 wrangler 提升到仓库根，也可能嵌在 worker workspace 下
// （wrangler 4.156 起就是后者），两种布局都要能找到。
const wranglerCandidates = [
  join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
  join(root, 'worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
];

export function resolveWrapperCommand(args) {
  if (args[0] === 'deploy') {
    return { type: 'managed-deploy', mode: 'deploy', args: args.slice(1) };
  }
  if (args[0] === 'versions' && args[1] === 'upload') {
    return { type: 'managed-deploy', mode: 'versions-upload', args: args.slice(2) };
  }
  return { type: 'passthrough', args };
}

function run() {
  const command = resolveWrapperCommand(process.argv.slice(2));
  const child = command.type === 'managed-deploy'
    ? spawnSync(process.execPath, [managedDeploy, ...command.args], {
      cwd: root,
      env: { ...process.env, CF_MONITOR_DEPLOY_COMMAND: command.mode },
      stdio: 'inherit',
    })
    : spawnWrangler(command.args);
  process.exit(child.status ?? 1);
}

function spawnWrangler(args) {
  const wrangler = wranglerCandidates.find(candidate => existsSync(candidate));
  if (!wrangler) {
    console.error(`Cannot locate wrangler; expected one of:\n${wranglerCandidates.join('\n')}`);
    return { status: 1 };
  }
  return spawnSync(process.execPath, [wrangler, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
