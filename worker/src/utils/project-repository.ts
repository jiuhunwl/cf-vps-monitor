/**
 * 本仓库的权威标识（单一事实来源）。
 *
 * worker 侧凡是需要“本仓库是谁”的地方（agent 安装脚本的 302 重定向、
 * 后台“版本更新”检测的默认更新源）都必须从这里取值，避免同一仓库标识
 * 在多个文件里各写一份字面量而再次漂移。
 */

/** `owner/repo`，GitHub API 与 raw 地址都以它为准。 */
export const CF_MONITOR_REPOSITORY = 'jiuhunwl/cf-vps-monitor';

/** 默认分支；源码归档与更新检测都以该分支为准。 */
export const CF_MONITOR_BRANCH = 'main';

/** 仓库网页地址。 */
export const CF_MONITOR_GITHUB_URL = `https://github.com/${CF_MONITOR_REPOSITORY}`;

/** raw.githubusercontent.com 基址，用于 agent 安装脚本的 302 重定向。 */
export const CF_MONITOR_RAW_BASE = `https://raw.githubusercontent.com/${CF_MONITOR_REPOSITORY}/${CF_MONITOR_BRANCH}`;
