import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicCodes = new Set([
  'ERR_ASSERTION', 'ERR_TEST_FAILURE', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE',
]);
const escapeData = value => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = value => escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');

// Report only test metadata. Never serialize assertions, stacks, request bodies,
// environment variables, or arbitrary error messages into public annotations.
export function formatFailure(event, root = process.cwd()) {
  if (event?.type !== 'test:fail' || typeof event.data?.file !== 'string') return '';
  const data = event.data;
  let file;
  try { file = data.file.startsWith('file:') ? fileURLToPath(data.file) : data.file; }
  catch { return ''; }
  const local = relative(resolve(root), resolve(root, file));
  if (!local || local === '..' || local.startsWith('..' + sep) || isAbsolute(local)) return '';
  const parts = local.split(sep);
  if (parts.some(part => ['.git', '.tmp', 'node_modules'].includes(part))) return '';
  const fields = ['file=' + escapeProperty(parts.join('/'))];
  if (Number.isSafeInteger(data.line) && data.line > 0) {
    fields.push('line=' + data.line);
    if (Number.isSafeInteger(data.column) && data.column > 0) fields.push('col=' + data.column);
  }
  fields.push('title=Node.js test failure');
  const name = typeof data.name === 'string' ? [...data.name].slice(0, 200).join('') : 'JavaScript test';
  const error = data.details?.error;
  const code = [error?.cause?.code, error?.code].find(value => publicCodes.has(value));
  return '::error ' + fields.join(',') + '::' + escapeData(name) + (code ? ' [' + code + ']' : '') + '\n';
}

export default async function* githubReporter(source) {
  const enabled = process.env.GITHUB_ACTIONS === 'true';
  for await (const event of source) {
    if (!enabled) continue;
    const annotation = formatFailure(event);
    if (annotation) yield annotation;
  }
}
