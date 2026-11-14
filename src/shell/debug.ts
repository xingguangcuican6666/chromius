/**
 * 宿主的调试日志开关。
 *
 * 排查子应用「接入了但没窗口 / 窗口白了」时，真正有用的信息几乎全在
 * webContents 事件里（did-fail-load、console-message、render-process-gone），
 * 而这些事件默认完全静默。但它们噪音也大：一个正常的 VS Code 系应用启动会打
 * 上百条 console-message。
 *
 * 所以：默认关闭，`CHROMIUS_DEBUG=1` 打开。错误类日志不受此开关影响。
 */
const ENABLED =
  process.env['CHROMIUS_DEBUG'] === '1' ||
  process.env['CHROMIUS_DEBUG'] === 'true' ||
  process.env['CHROMIUS_DEBUG'] === 'all';

export function debugEnabled(): boolean {
  return ENABLED;
}

/** 调试日志：仅 CHROMIUS_DEBUG 打开时输出。 */
export function debug(...args: unknown[]): void {
  if (ENABLED) console.warn('[chromius]', ...args);
}
