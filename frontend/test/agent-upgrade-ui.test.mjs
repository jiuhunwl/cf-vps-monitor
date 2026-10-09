import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { productionDeclaration, productionJsx, productionModule } from './helpers/production-module.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const React = require('react');
const themes = require('@radix-ui/themes');
const { renderToStaticMarkup } = require('react-dom/server');
const { Terminal, RotateCw } = require('lucide-react');
const presets = ['https://gh-proxy.org', 'https://v4.gh-proxy.org', 'https://v6.gh-proxy.org', 'https://cdn.gh-proxy.org', 'https://axisnow.gh-proxy.org'];
const proxyFile = 'src/components/admin/GitHubProxyInput.tsx';
const manualFile = 'src/components/admin/AgentManualUpgradeDialog.tsx';
const dashboardFile = 'src/pages/admin/Dashboard.tsx';
const remoteFile = 'src/components/admin/AgentUpgradeDialog.tsx';
const render = element => renderToStaticMarkup(React.createElement(themes.Theme, null, element));
const attr = (tag, key) => tag.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1];

function* elements(element) {
  if (Array.isArray(element)) { for (const child of element) yield* elements(child); return; }
  if (!React.isValidElement(element)) return;
  yield element;
  yield* elements(element.props.children);
}
function text(element) {
  if (Array.isArray(element)) return element.map(text).join('');
  if (React.isValidElement(element)) return text(element.props.children);
  return typeof element === 'string' ? element : '';
}

// Use real React, Radix TextField and native datalist markup, not source-string assertions.
test('GitHub proxy picker renders all presets, keeps direct access as the default and accepts a custom value', () => {
  const { default: GitHubProxyInput } = productionModule(proxyFile);
  for (const value of ['', 'https://custom.example/github', 'custom.example/github']) {
    const html = render(React.createElement(GitHubProxyInput, { value, onChange() {} }));
    const input = html.match(/<input\b[^>]*>/)?.[0];
    assert.ok(input);
    assert.equal(attr(input, 'value'), value);
    assert.equal(attr(input, 'aria-invalid'), undefined);
    assert.ok(html.includes(`for="${attr(input, 'id')}"`));
    assert.ok(html.includes(`<datalist id="${attr(input, 'list')}">`));
    for (const preset of presets) assert.ok(html.includes(`<option value="${preset}"`));
    assert.equal((html.match(/<option /g) || []).length, 5);
    assert.ok(html.includes('留空为直连'));
  }
});

test('multiple proxy pickers have unique accessible IDs and reject insecure content mirrors', () => {
  const { default: GitHubProxyInput } = productionModule(proxyFile);
  const html = render(React.createElement(React.Fragment, null,
    React.createElement(GitHubProxyInput, { value: '', onChange() {} }),
    React.createElement(GitHubProxyInput, { value: 'http://insecure.example', onChange() {} })));
  const inputs = html.match(/<input\b[^>]*>/g);
  assert.equal(inputs.length, 2);
  assert.notEqual(attr(inputs[0], 'id'), attr(inputs[1], 'id'));
  assert.notEqual(attr(inputs[0], 'list'), attr(inputs[1], 'list'));
  assert.equal(attr(inputs[1], 'aria-invalid'), 'true');
  assert.ok(html.includes(`id="${attr(inputs[1], 'aria-describedby')}"`));
  assert.ok(html.includes('HTTPS'));
});

const Shell = ({ children }) => React.createElement(React.Fragment, null, children);
// Only replace the portal shell: its browser-only mount is outside these SSR/interaction tests.
const dialogShell = { Root: Shell, Content: Shell, Title: Shell, Description: Shell };
const denyApi = () => { throw new Error('manual upgrade must not request or rotate credentials'); };

test('manual upgrade renders independently of authentication and never includes the node Token', () => {
  const { default: ManualDialog } = productionModule(manualFile, {
    '@radix-ui/themes': { ...themes, Dialog: dialogShell },
    '../../contexts/AuthContext': { useApi: denyApi },
  }, { fetch: denyApi });
  const html = render(React.createElement(ManualDialog, {
    target: { name: 'legacy node', os: 'Linux', version: 'v1.0.0', targetVersion: 'v2.0.4', token: 'DO_NOT_COPY_THIS_TOKEN', uuid: 'NOT_AN_INSTANCE_ID' },
    onClose() {},
  }));
  assert.ok(html.includes('手动升级'));
  assert.ok(html.includes('--upgrade'));
  assert.ok(html.includes('v2.0.4'));
  assert.ok(html.includes('不会撤销'));
  assert.ok(!html.includes('DO_NOT_COPY_THIS_TOKEN'));
  assert.ok(!html.includes('NOT_AN_INSTANCE_ID'));
});

function manualHarness(target) {
  const states = [];
  let cursor = 0;
  const copies = [];
  const messages = [];
  const { default: ManualDialog } = productionModule(manualFile, {
    react: { ...React, useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    } },
    '../../contexts/AuthContext': { useApi: denyApi },
    sonner: { toast: { success: message => messages.push(message), error: message => messages.push(message) } },
  }, { navigator: { clipboard: { async writeText(value) { copies.push(value); } } }, fetch: denyApi });
  const view = (nextTarget = target) => { cursor = 0; return ManualDialog({ target: nextTarget, onClose() {} }); };
  const field = (element, label) => [...elements(element)].find(item => item.props.label === label);
  const copyButton = element => [...elements(element)].find(item => item.type === themes.Button && text(item).includes('复制手动升级命令'));
  return { view, field, copyButton, copies, messages };
}

test('manual target is an opening snapshot and invalid settings fail closed at both button and handler', async () => {
  const target = { name: 'legacy', os: 'Linux', version: 'v1.0.0', targetVersion: 'v2.0.4' };
  const h = manualHarness(target);
  h.field(h.view(), '目标 Release Tag').props.onChange('v2.0.5');
  assert.equal(h.field(h.view({ ...target, targetVersion: 'v3.0.0' }), '目标 Release Tag').props.value, 'v2.0.5');
  h.field(h.view(), '原安装目录').props.onChange('/tmp/bad\npath');
  const button = h.copyButton(h.view());
  assert.equal(button.props.disabled, true);
  await button.props.onClick();
  assert.deepEqual(h.copies, []);
});

test('manual downgrade requires confirmation and changing the release invalidates that confirmation', async () => {
  const h = manualHarness({ name: 'legacy', os: 'Linux', version: 'v3.0.0', targetVersion: 'v2.0.4' });
  let view = h.view();
  assert.equal(h.copyButton(view).props.disabled, true);
  [...elements(view)].find(item => item.type === themes.Checkbox).props.onCheckedChange(true);
  view = h.view();
  assert.equal(h.copyButton(view).props.disabled, false);
  await h.copyButton(view).props.onClick();
  assert.equal(h.copies.length, 1);
  assert.ok(h.copies[0].includes('--upgrade'));
  assert.ok(h.messages[0].includes('执行'));
  h.field(view, '目标 Release Tag').props.onChange('v2.0.3');
  assert.equal(h.copyButton(h.view()).props.disabled, true);
});

test('Dashboard manual entry is available even when remote upgrade is already latest', () => {
  const calls = [];
  const node = { uuid: 'legacy-node', name: 'legacy', version: 'v2.0.4' };
  const action = productionJsx(dashboardFile, (element, ast, ts) => ts.isJsxElement(element)
    && element.openingElement.tagName.getText(ast) === 'RowActionButton'
    && element.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute)
      && attribute.name.getText(ast) === 'label' && attribute.initializer?.getText(ast) === '"手动升级"'), {
    RowActionButton: Shell, Terminal, node, upgradeUpToDate: true, onManualUpgrade: value => calls.push(value),
  });
  assert.notEqual(action.props.disabled, true);
  action.props.onClick();
  assert.equal(calls[0], node);
});

test('Dashboard only stores non-secret manual target details and never reuses the install dialog', () => {
  const node = { uuid: 'legacy-node', name: 'legacy', version: 'v1.0.0', token: 'DO_NOT_KEEP' };
  let captured;
  const open = productionDeclaration(dashboardFile, 'openManualUpgrade', {
    clients: [{ ...node, os: 'Windows' }], agentLatestVersion: 'v2.0.4',
    setManualTarget: value => { captured = value; }, setCmdClient: denyApi, setCmdOpen: denyApi,
  });
  open(node);
  assert.deepEqual(JSON.parse(JSON.stringify(captured)), { name: 'legacy', version: 'v1.0.0', os: 'Windows', targetVersion: 'v2.0.4' });
  open(node, 'v2.0.3');
  assert.equal(captured.targetVersion, 'v2.0.3');
});

test('remote fallback uses the actual queued command version, not a newer release suggestion', () => {
  const upgrade = productionModule('src/utils/agentUpgrade.ts');
  const Row = productionDeclaration(remoteFile, 'UpgradeNodeRow', {
    ...themes, ...upgrade, Terminal, RotateCw, AgentUpgradeStatusBadge: Shell,
  });
  const node = { uuid: 'legacy', name: 'legacy', version: 'v1.0.0' };
  const calls = [];
  const tree = Row({ node, targetVersion: 'v3.0.0', command: { target_version: 'v2.0.4', status: 'queued' },
    busy: true, onRetry: denyApi, onManualUpgrade: (...args) => calls.push(args) });
  const button = [...elements(tree)].find(item => item.type === themes.Button && text(item).includes('手动升级'));
  assert.ok(button);
  assert.notEqual(button.props.disabled, true);
  button.props.onClick();
  assert.equal(calls[0][0], node);
  assert.equal(calls[0][1], 'v2.0.4');
});

test('opening the manual fallback stops local tracking without sending a cancellation request', () => {
  const calls = [];
  const open = productionDeclaration(remoteFile, 'handleManualUpgrade', {
    handleOpenChange: value => calls.push(['close', value]),
    onManualUpgrade: (node, version) => calls.push(['manual', node.uuid, version]),
    apiFetch: denyApi,
  });
  open({ uuid: 'legacy' }, 'v2.0.4');
  assert.deepEqual(calls, [['close', false], ['manual', 'legacy', 'v2.0.4']]);
});
