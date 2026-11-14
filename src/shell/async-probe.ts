/**
 * 诊断用：在指定毫秒后 dump 所有「仍 pending 的 async 资源」的创建栈。
 *
 * 子应用的主进程入口常见 `main(){ this.startup() }`（未 await async startup），
 * 一旦内部某个 await 永远不 resolve，外部看不到任何错误，只表现为「什么都没发生」。
 * 这个探针把仍在等待的 Promise 的创建位置打出来，直接定位挂起点。
 */
import * as asyncHooks from 'async_hooks';

interface Pending {
  id: number;
  type: string;
  stack: string;
  at: number;
}

export function installAsyncProbe(delayMs: number, label: string): void {
  const pending = new Map<number, Pending>();
  const stacks = new Map<number, string>();

  const hook = asyncHooks.createHook({
    init(asyncId, type) {
      // 只关心 Promise 与定时器；其它资源噪音太大
      if (type !== 'PROMISE' && type !== 'Timeout') return;
      const stack = new Error().stack ?? '';
      // 跳过探针自身的栈帧
      const cleaned = stack
        .split('\n')
        .filter((l) => !l.includes('async-probe') && !l.includes('node:internal'))
        .slice(1, 12)
        .join('\n');
      stacks.set(asyncId, cleaned);
      pending.set(asyncId, { id: asyncId, type, stack: cleaned, at: Date.now() });
    },
    destroy(asyncId) {
      pending.delete(asyncId);
      stacks.delete(asyncId);
    },
    promiseResolve(asyncId) {
      pending.delete(asyncId);
    },
  });

  hook.enable();

  const started = Date.now();
  const timer = setTimeout(() => {
    const alive = [...pending.values()].filter((p) => p.type === 'PROMISE');
    console.error(
      `\n[chromius-probe] ${label}: ${alive.length} pending promises after ` +
        `${Date.now() - started}ms\n`,
    );
    // 后创建的更接近挂起点，只打最后 15 个
    for (const p of alive.slice(-15)) {
      console.error(`[chromius-probe] #${p.id} ${p.type}\n${p.stack}\n`);
    }
    hook.disable();
  }, delayMs);
  timer.unref?.();
}
