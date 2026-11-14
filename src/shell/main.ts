/**
 * Chromius 宿主入口。由 daemon 以如下方式拉起：
 *   <electron-binary> out/shell/main.js --chromius-host=<major> --socket=<path>
 *
 * 它不加载任何 App 的代码，只做「窗口工厂 + 子应用注册表 + socket 服务」。
 */
import { app, protocol } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { startSocketServer } from './ipc-server';
import { decideMode, ClientSpec } from '../shared/spec';
import { PRIVILEGED_SCHEMES } from '../shared/schemes';
import { detectFromBinary } from '../shared/detect';
import {
  createClient,
  getClients,
  openWebWindow,
  ensureSessionPolicy,
  removeClient,
  userDataFor,
} from './clients';
import { startVmClient } from './vm-client';

// —— 在 app ready 之前设置与图形相关的 switch ——
app.commandLine.appendSwitch('ozone-platform', 'wayland');
app.disableHardwareAcceleration();

/**
 * 在 ready 之前预注册 privileged scheme。清单与理由见 shared/schemes.ts。
 *
 * 必须在模块顶层调用（此时 app 尚未 ready）；宿主 ready 之后子应用自己的注册
 * 会被虚拟 protocol 吞掉并打日志。
 */
protocol.registerSchemesAsPrivileged(PRIVILEGED_SCHEMES as Electron.CustomScheme[]);

function parseArgs(): { major: string; socket: string } {
  let major = 'unknown';
  let socket = '';
  for (const a of process.argv) {
    if (a.startsWith('--chromius-host=')) major = a.slice('--chromius-host='.length);
    if (a.startsWith('--socket=')) socket = a.slice('--socket='.length);
  }
  return { major, socket };
}

const { major, socket } = parseArgs();

// 子应用的主进程入口常见写法是 `main(){ try { this.startup() } ... }`，其中
// startup() 是 async 但**没有被 await**。它内部的任何失败都只会变成未处理的
// Promise rejection —— 表现为「入口求值完成、但什么都没发生」。宿主默认只打一行
// 警告，这里把完整堆栈打出来，否则排查时看不到任何线索。
//
// 但 VS Code 系会大量抛 `Canceled`：那是它内部的取消信号（pty host、扩展宿主
// 请求被用户打断等），属于正常控制流，单次会话能刷出几十条完整堆栈。过滤掉它，
// 否则真正的错误会被淹掉。
process.on('unhandledRejection', (reason) => {
  const e = reason as { stack?: string; message?: string; name?: string } | undefined;
  const msg = e?.message ?? (e?.name ? `${e.name}: ${String(reason)}` : String(reason));
  if (e?.name === 'Canceled' || msg === 'Canceled' || msg === 'Canceled: Canceled') return;
  console.error('[chromius-host] unhandled rejection:', e?.stack ?? msg);
});

// 宿主自己不应有窗口；保活
app.on('window-all-closed', () => {
  // 不退出：宿主要一直活着等待新子应用
});

let vmRuns = new Map<string, { dispose: () => void }>();

async function handleMessage(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  const kind = msg['kind'] as string;

  if (kind === 'launch') {
    const realBinary = String(msg['realBinary'] || '');
    const detected = detectFromBinary(realBinary);
    if (!detected) {
      return { ok: true, attached: false, reason: 'not an electron app (no app payload found)' };
    }

    // 主版本必须匹配（原生模块 ABI / V8 绑定），否则无法共享本宿主
    if (detected.major !== major && detected.major !== '0') {
      return {
        ok: true,
        attached: false,
        reason: `runtime mismatch: app is Electron/Chromium ${detected.major}, host is ${major}`,
      };
    }

    const argv = (msg['argv'] as string[]) || [];
    const cwd = String(msg['cwd'] || '');
    const env = (msg['env'] as Record<string, string>) || {};
    const mode = decideMode(detected.entry, detected.hasNativeModules);

    const spec: ClientSpec = {
      id: detected.id,
      displayName: detected.displayName,
      mode,
      appPath: detected.appPath,
      entry: detected.entry,
      realBinary: detected.realBinary,
      major: detected.major,
      hasNativeModules: detected.hasNativeModules,
      argv,
      cwd,
      env,
    };

    // 原生模块无法在共享宿主里安全运行（进程级全局状态 + ABI 绑定）
    if (detected.hasNativeModules) {
      return {
        ok: true,
        attached: false,
        reason: 'app bundles native .node modules (cannot share host)',
      };
    }

    const client = createClient(spec);
    ensureSessionPolicy(spec.id);

    try {
      if (mode === 'vm') {
        const rootDir = userDataFor(spec);
        fs.mkdirSync(rootDir, { recursive: true });
        const vmHandle = startVmClient(spec, rootDir, () => {
          vmRuns.delete(spec.id);
        }, client.windows);
        vmHandle.run();
        vmRuns.set(spec.id, vmHandle);
      } else {
        const url = guessWebUrl(spec);
        if (!url) {
          return { ok: true, attached: false, reason: 'web-mode app: no launchable url' };
        }
        openWebWindow(client, url);
      }
    } catch (e) {
      removeClient(spec.id);
      return {
        ok: true,
        attached: false,
        reason: `attach failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    return {
      ok: true,
      attached: true,
      client: {
        id: spec.id,
        mode,
        displayName: spec.displayName,
        windowCount: getClients().find((c) => c.spec.id === spec.id)?.windows.length ?? 0,
        hostPid: process.pid,
      },
    };
  }

  if (kind === 'kill') {
    const id = String(msg['id'] || '');
    vmRuns.get(id)?.dispose();
    vmRuns.delete(id);
    removeClient(id);
    return { ok: true };
  }

  if (kind === 'status') {
    return {
      ok: true,
      shellPid: process.pid,
      major,
      clients: getClients().map((c) => ({
        id: c.spec.id,
        mode: c.spec.mode,
        displayName: c.spec.displayName,
        windowCount: c.windows.length,
        hostPid: process.pid,
      })),
    };
  }

  return { ok: false, error: `unknown kind: ${kind}` };
}

function guessWebUrl(spec: ClientSpec): string | null {
  // web 型：优先用 argv 里的 URL（用户可能传了要打开的网址）
  for (const a of spec.argv) {
    if (/^https?:\/\//.test(a) || /^file:\/\//.test(a)) return a;
  }
  return null;
}

app.whenReady().then(async () => {
  if (!socket) {
    console.error('[chromius-host] missing --socket=');
    app.exit(2);
    return;
  }
  await startSocketServer(socket, handleMessage);
  console.log(`[chromius-host] ready major=${major} pid=${process.pid} socket=${socket}`);
  void path;
});
