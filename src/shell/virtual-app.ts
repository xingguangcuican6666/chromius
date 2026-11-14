/**
 * 虚拟 app —— 在 vm 沙盒里给每个子应用一个「看起来独立」的 app 对象。
 *
 * 为什么需要：Electron 的 `app` 是进程级单例。多个子应用共享同一个宿主主进程，
 * 若都直接用真实 app，它们的 userData、名称、单实例锁会互相踩。
 * 这里用 Proxy 包装真实 app，对子应用暴露隔离的路径/名称/生命周期，底层仍是唯一的 app。
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { PRE_REGISTERED_SCHEMES } from '../shared/schemes';
import type { ClientSpec } from './clients';

export type VirtualApp = InstanceType<typeof Proxy> & Record<string, unknown>;

export interface VirtualAppContext {
  /** 子应用专属的根目录（相当于它的 userData 的父目录） */
  rootDir: string;
}

export function makeVirtualApp(
  spec: ClientSpec,
  rootDir: string,
  /** 与 electron facade 共享的 scheme 注册表，dispose 时统一撤销。 */
  registeredSchemes: Set<string> = new Set(),
): Record<string, unknown> {
  const name = spec.displayName;

  const basePath = (p: string): string => {
    // 子应用拿到的任何路径都收敛到它自己的目录下
    return path.join(rootDir, p);
  };

  const virtual: Record<string, unknown> = {};

  /** 子应用自己 setPath 过的路径（只存在于虚拟层）。 */
  const overridden: Record<string, string> = {};
  /** launch 前的活跃句柄快照，用来识别本子应用新起的 socket server。 */
  const handlesBefore = snapshotHandles();

  /** 子应用在真实 app 上注册过的监听器，dispose 时逐个撤销。 */
  const appListeners: Array<{ event: string; listener: (...a: unknown[]) => void }> = [];

  const proxy = new Proxy(app as unknown as Record<string, unknown>, {
    get(target, prop: string | symbol) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop);

      // 宿主内部用的键（_dispose / _onQuit / _userData / _proxy）。
      // 必须在这里拦下来：default 分支是 `Reflect.get(真实 app, prop)`，
      // 真实 app 上当然没有这些键，返回 undefined——宿主就调不到自己的钩子了。
      if (prop.startsWith('_')) return virtual[prop];

      switch (prop) {
        case 'getName':
          return () => name;
        case 'setName':
          return () => void 0; // 忽略：不让子应用改全局名
        case 'getPath': {
          return (key: string) => {
            // 子应用自己 setPath 过的路径优先返回它设的值（VS Code 系在入口里
            // 会 setPath('userData', ...)，随后所有派生路径都基于它）。
            if (Object.prototype.hasOwnProperty.call(overridden, key)) {
              return overridden[key];
            }
            // userData / logs / cache 等落到子应用自己的目录
            if (key === 'userData') return basePath('userData');
            if (key === 'logs') return basePath('logs');
            if (key === 'sessionData') return basePath('sessionData');
            if (key === 'temp') return basePath('temp');
            // 其余（home/downloads 等）透传真实值
            const real = target.getPath as (k: string) => string;
            return real(key);
          };
        }
        case 'setPath':
          return (key: string, value: string) => {
            // 只记录在虚拟层，**绝不**写真实 app。
            //
            // 这里曾直接把 userData 吞掉不记录，导致 getPath('userData') 仍返回
            // 虚拟默认值，而子应用内部所有派生路径（VS Code 系的 mainIPCHandle、
            // mainLockfile 都在其中）都基于它算出来。若 setPath 不生效，
            // 这些路径会与「真实 app 的 userData」或上一个实例的路径撞车：
            // 第二个实例 claimInstance 时连到第一个实例遗留的 socket 监听器，
            // 判定「已有实例在跑」，于是 quit 自己——表现为「attached 成功、
            // 求值完成、但一个窗口都没有」。
            overridden[key] = value;
            virtual['_userData'] = value;
          };
        case 'getAppPath':
          return () => spec.appPath;
        case 'getVersion':
          return () => '1.0.0'; // 由 package.json 覆盖更准确，暂用占位
        case 'isPackaged':
          return () => true;
        case 'quit':
          return () => {
            // 子应用「退出」= 关闭它自己的窗口，不是退出宿主
            if (typeof virtual['_onQuit'] === 'function') (virtual['_onQuit'] as () => void)();
          };
        case 'exit':
          return () => {
            if (typeof virtual['_onQuit'] === 'function') (virtual['_onQuit'] as () => void)();
          };
        case 'requestSingleInstanceLock':
          return () => acquireClientLock(spec, rootDir);
        case 'releaseSingleInstanceLock':
          return () => releaseClientLock(spec, rootDir);
        case 'disableHardwareAcceleration':
          // 进程级开关：在共享宿主里无 per-app 意义，记录并忽略
          return () => void 0;
        // 以下都是「必须在 app ready 之前调用」的进程级开关。
        // 宿主早已 ready，真实调用会抛错；子应用只是设置偏好，无害地吞掉即可。
        case 'enableSandbox':
        case 'disableDomainBlockingFor3DAPIs':
        case 'setAsDefaultProtocolClient':
        case 'setLoginItemSettings':
        case 'allowRendererProcessReuse':
        case 'enableMixedSandbox':
          return () => void 0;
        case 'protocol': {
          // protocol 在 electron 里是模块级导出（不是 app 的属性）。
          // 子应用会调用 registerSchemesAsPrivileged——它要求「app ready 前」调用，
          // 宿主已 ready，真实调用会抛错。这里返回一个代理：吞掉已预注册 scheme
          // 的重复注册，其余方法全部透传给真实的顶层 protocol。
          return makeVirtualProtocol(spec, registeredSchemes);
        }
        case 'commandLine': {
          // 子应用在 ready 前 appendSwitch 是「按需挂载特性」的核心诉求。
          // 宿主已启动，Chromium 开关无法再改；这里记录到本子应用的特性表，
          // 供后续窗口/会话使用（并在日志里可见）。
          return makeVirtualCommandLine(spec);
        }
        case 'whenReady':
          // 宿主已 ready，子应用调用应立即 resolve（而不是等一个不会再来的事件）
          return () => Promise.resolve();
        case 'isReady':
          return () => true;
        // ready 事件是启动链的命门：真实 app 早已 ready，`once('ready', cb)`
        // 永远不会再触发。VS Code 系主进程的入口正是
        //   app.once('ready', () => runMainBundle())
        // 一旦这个回调不跑，主进程入口模块根本不会被求值——表现为
        // 「main.js 求值完成、但没有任何窗口、没有任何日志」。
        // 语义上等价于 isReady()===true：已 ready 的 app 上注册的 ready 回调
        // 应当立即执行。
        case 'on':
        case 'once':
        case 'addListener':
          return (event: string, listener: (...a: unknown[]) => void) => {
            if (event === 'ready') {
              // 异步触发，保持与真实事件一致的「不重入当前栈」行为
              process.nextTick(() => {
                try {
                  listener();
                } catch (e) {
                  console.error(
                    `[chromius] ${spec.id}: ready listener threw: ` +
                      (e instanceof Error ? e.stack ?? e.message : String(e)),
                  );
                }
              });
              return proxy;
            }
            const fn = (target as Record<string, unknown>)[prop] as
              | ((...a: unknown[]) => unknown)
              | undefined;
            if (typeof fn !== 'function') return proxy;
            fn.call(target, event, listener);
            // 记下来，dispose 时撤销。子应用注册的是**真实的** app 监听器
            // （quit / window-all-closed / before-quit …），kill 后重新 launch
            // 会再注册一遍，旧实例的回调仍挂在进程上，会在新实例上重放。
            appListeners.push({ event, listener });
            return proxy;
          };
        default: {
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      }
    },
  });

  virtual['_proxy'] = proxy;
  // 撤销本子应用注册在真实 app 上的监听器。同一宿主里 kill 后重新 launch
  // 同一 App 时，旧实例的 quit / window-all-closed 回调若不摘掉，会在新实例
  // 的事件上重放（例如旧实例的 quit 回调把新实例的窗口关掉）。
  virtual['_dispose'] = () => {
    const realApp = app as unknown as Record<string, unknown>;
    const removeListener = realApp['removeListener'] as
      | ((e: string, fn: (...a: unknown[]) => void) => void)
      | undefined;
    for (const { event, listener } of appListeners) {
      try {
        removeListener?.call(app, event, listener);
      } catch {
        /* 已不存在 */
      }
    }
    appListeners.length = 0;

    // 撤销 protocol handler。VS Code 系在 defaultSession 上注册
    // vscode-file / vscode-webview 的 handler；不摘掉的话，同一宿主里重新
    // launch 会抛 `Failed to register protocol: vscode-webview`，新实例起不来。
    if (registeredSchemes.size) {
      const electron = require('electron') as Record<string, unknown>;
      const ses = electron['session'] as Record<string, unknown> | undefined;
      const defaultSession = ses?.['defaultSession'] as Record<string, unknown> | undefined;
      const sessionProto = defaultSession?.['protocol'] as Record<string, unknown> | undefined;
      const topProto = electron['protocol'] as Record<string, unknown> | undefined;
      for (const scheme of registeredSchemes) {
        for (const p of [sessionProto, topProto]) {
          const un = p?.['unhandle'] as ((s: string) => void) | undefined;
          try {
            un?.call(p, scheme);
          } catch {
            /* 已不存在 */
          }
        }
      }
      registeredSchemes.clear();
    }

    // 关掉子应用自己起的 unix socket server。
    //
    // VS Code 系在 userData 下算出一个固定的 `mainIPCHandle`（形如
    // `/run/user/1000/vscode-<hash>-<ver>-main.sock`），启动时 listen 它，
    // 用来判断「是否已有实例在跑」。这个路径**每次 launch 都相同**。kill 时
    // 若只关窗口，监听器仍留在进程里；下一次 launch 撞 EADDRINUSE → 应用认为
    // 已有实例 → 把参数转发过去然后自己 quit。表现就是
    // 「attached 成功、入口求值完成、但一个窗口都没有」。
    //
    // Node 没有枚举 server 的公开 API，但 `process._getActiveHandles()` 能拿到
    // 进程内所有活跃句柄。用 launch 前的快照取差集，只关本子应用新起的那些。
    closeClientServers(handlesBefore);
  };
  return proxy as unknown as Record<string, unknown>;
}

/** 每子应用独立的单实例锁（同一 App 第二次启动会被转发给第一个）。 */function lockPath(spec: ClientSpec, rootDir: string): string {
  return path.join(rootDir, `${spec.id}.lock`);
}

function acquireClientLock(spec: ClientSpec, rootDir: string): boolean {
  try {
    fs.mkdirSync(rootDir, { recursive: true });
    const p = lockPath(spec, rootDir);
    if (fs.existsSync(p)) {
      try {
        const pid = parseInt(fs.readFileSync(p, 'utf8'), 10);
        if (pid && isAlive(pid)) return false; // 已有实例
      } catch {
        /* 损坏的锁文件，当作没有 */
      }
    }
    fs.writeFileSync(p, String(process.pid));
    return true;
  } catch {
    return true; // 锁失败时放行，避免阻塞启动
  }
}

function releaseClientLock(spec: ClientSpec, rootDir: string): void {
  try {
    fs.unlinkSync(lockPath(spec, rootDir));
  } catch {
    /* ignore */
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 关闭本子应用启动的 unix socket server，并删掉残留的 socket 文件。
 *
 * 用途见 `_dispose` 里的调用点：VS Code 系的「是否已有实例在跑」判定依赖一个
 * 每次 launch 都相同的 socket 路径，不关掉旧监听器就会让新实例误判并自杀。
 *
 * 归属判定：socket 路径由子应用自己算（VS Code 系落在 $XDG_RUNTIME_DIR，
 * 不在 userData 下），没法用路径前缀判断。改用「该 client 启动后新出现的
 * server」——`before` 是 launch 前的快照，只关差集。
 *
 * 只处理 unix socket（`_connectionKey` 形如 `-1:/path:-1`），不碰 TCP server。
 */
function closeClientServers(before: Set<unknown>): void {
  const getHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })
    ._getActiveHandles;
  if (typeof getHandles !== 'function') return;

  const all = getHandles.call(process);

  for (const h of all) {
    if (before.has(h)) continue; // 启动前就有，属于别人
    const srv = h as { _connectionKey?: string; close?: () => void };
    const key = srv?._connectionKey;
    if (typeof key !== 'string' || typeof srv.close !== 'function') continue;
    // 格式：`<fd>:<address>:<port>`，unix socket 的 fd/port 都是 -1
    const m = /^-1:(.+):-1$/.exec(key);
    if (!m) continue;
    const sockPath = m[1];
    try {
      srv.close();
    } catch {
      /* 已关闭 */
    }
    try {
      fs.unlinkSync(sockPath);
    } catch {
      /* 文件可能已被删 */
    }
  }
}

/** 记录当前进程内所有活跃句柄，作为「启动前就有」的快照。 */
function snapshotHandles(): Set<unknown> {
  const getHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })
    ._getActiveHandles;
  if (typeof getHandles !== 'function') return new Set();
  return new Set(getHandles.call(process));
}

/**
 * 子应用看到的 commandLine。真实开关只能在宿主启动前设置；宿主已运行后
 * 这里的调用被记录下来，作为该子应用的「请求的特性」，用于：
 *   - 日志可见（排查为什么某特性没生效）
 *   - 未来：决定该子应用是否需要「专用宿主」
 */
function makeVirtualCommandLine(spec: ClientSpec): Record<string, unknown> {
  const switches = new Map<string, string | undefined>();
  return {
    hasSwitch: (name: string) => switches.has(name),
    getSwitchValue: (name: string) => switches.get(name) ?? '',
    appendSwitch: (name: string, value?: string) => {
      switches.set(name, value);
      console.warn(
        `[chromius] ${spec.id}: requested switch ${name}${value ? '=' + value : ''} ` +
          `(host already running; recorded only)`,
      );
    },
    appendArgument: (arg: string) => {
      console.warn(`[chromius] ${spec.id}: requested argument ${arg} (recorded only)`);
    },
    removeSwitch: (name: string) => {
      switches.delete(name);
    },
  };
}

/**
 * 子应用看到的 protocol 视图。
 *
 * electron 的 protocol 是模块级导出。其中 registerSchemesAsPrivileged 必须在
 * app ready 前调用，**ready 后再调会直接抛错**（不是静默忽略）。子应用的入口在
 * 宿主 ready 之后才求值，所以这一步只能由宿主代劳：宿主在 main.ts 顶层预注册了
 * shared/schemes.ts 里的清单，这里把子应用的重复注册吞掉。
 *
 * 吞掉是安全的，因为 privileged 标记是**进程级**的：宿主已经用同样的 privileges
 * 注册过，子应用再注册一次结果相同。但如果子应用要注册一个宿主没预注册的 scheme，
 * 吞掉就会让它悄悄失效（origin 变 null → 白屏），所以那种情况必须打警告。
 *
 * 另外记录 handle/handleOnce 注册过的 scheme。dispose 时撤销——同一个宿主里
 * kill 后重新 launch 同一 App，新实例会再次 `protocol.handle('vscode-webview')`，
 * 而 Electron 对同一 session 的重复 scheme 注册会抛
 * `Failed to register protocol: vscode-webview`，新实例当场起不来。
 */
function makeVirtualProtocol(spec: ClientSpec, registered: Set<string>): Record<string, unknown> {
  // 用宿主启动时就已加载的真实 electron 模块引用。不要在这里 require：
  // 子应用可能以 ESM 加载，此时动态 require('electron') 会进入 ESM hook 的解析图，
  // 形成 require(esm) 循环而报错。
  const electronMod = require('electron');
  const real = electronMod.protocol as Record<string, unknown>;
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'registerSchemesAsPrivileged') {
        return (schemes: Array<{ scheme: string; privileges?: Record<string, boolean> }>) => {
          for (const s of schemes) {
            if (!PRE_REGISTERED_SCHEMES.has(s.scheme)) {
              console.warn(
                `[chromius] ${spec.id}: scheme "${s.scheme}" is NOT pre-registered by the host. ` +
                  `Registration after ready is a no-op, so this scheme will have an opaque origin ` +
                  `(CSP 'self' will reject its resources). Add it to src/shared/schemes.ts.`,
              );
            }
          }
        };
      }
      if (prop === 'handle' || prop === 'handleOnce') {
        const fn = Reflect.get(target, prop) as (s: string, h: unknown) => void;
        return (scheme: string, handler: unknown) => {
          registered.add(scheme);
          return fn.call(target, scheme, handler);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
