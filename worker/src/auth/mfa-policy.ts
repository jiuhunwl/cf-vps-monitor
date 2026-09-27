const EXACT_PROTECTED_PATHS = new Set([
  '/api/admin/account/username',
  '/api/admin/account/chpasswd',
  // 新建节点会**返回该节点的 Agent token**，与 /clients/:uuid/token 同级敏感，
  // 所以必须和它一样要求 step-up。此前只有 token 相关路径在 CLIENT_SECRET_PATH 里，
  // 新增节点这条入口漏了。
  '/api/admin/clients/add',
  '/api/admin/clients/batch-remove',
  '/api/admin/record/clear',
  '/api/admin/record/clear/all',
  '/api/admin/download/backup',
  '/api/admin/upload/backup',
  '/api/admin/account/mfa/setup',
  '/api/admin/account/mfa/enable',
  '/api/admin/account/mfa/recovery-codes',
  '/api/admin/account/mfa/disable',
]);

const CLIENT_SECRET_PATH = /^\/api\/admin\/clients\/[^/]+\/(?:remove|token(?:\/install|\/rotate)?)$/;

export function isMfaStepUpProtectedRequest(method: string, pathname: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  return EXACT_PROTECTED_PATHS.has(pathname) || CLIENT_SECRET_PATH.test(pathname);
}