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
import type { ClientSpec } from './clients';

export type VirtualApp = InstanceType<typeof Proxy> & Record<string, unknown>;

export interface VirtualAppContext {
  /** 子应用专属的根目录（相当于它的 userData 的父目录） */
  rootDir: string;
}

export function makeVirtualApp(spec: ClientSpec, rootDir: string): Record<string, unknown> {
  const name = spec.displayName;

  const basePath = (p: string): string => {
    // 子应用拿到的任何路径都收敛到它自己的目录下
    return path.join(rootDir, p);
  };

  const virtual: Record<string, unknown> = {};

  const proxy = new Proxy(app as unknown as Record<string, unknown>, {
    get(target, prop: string | symbol) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop);

      switch (prop) {
        case 'getName':
          return () => name;
        case 'setName':
          return () => void 0; // 忽略：不让子应用改全局名
        case 'getPath': {
          return (key: string) => {
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
            if (key === 'userData') {
              // 只记录在本子应用的 rootDir 下
              virtual['_userData'] = value;
              return;
            }
            (target.setPath as (k: string, v: string) => void)(key, value);
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
          // 宿主已 ready，真实调用会抛错。这里返回一个代理：吞掉这个调用，
          // 其余方法全部透传给真实的顶层 protocol。
          return makeVirtualProtocol();
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
        default: {
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      }
    },
  });

  virtual['_proxy'] = proxy;
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
 * app ready 前调用；宿主已 ready，因此吞掉它。其余方法透传真实实现——
 * 但注意：真实 protocol 是进程级的，多个子应用共享同一套 handler 命名空间，
 * 子应用应使用带自己前缀的 scheme（后续可通过 session.protocol 做得更彻底）。
 */
function makeVirtualProtocol(): Record<string, unknown> {
  // 用宿主启动时就已加载的真实 electron 模块引用。不要在这里 require：
  // 子应用可能以 ESM 加载，此时动态 require('electron') 会进入 ESM hook 的解析图，
  // 形成 require(esm) 循环而报错。
  const electronMod = require('electron');
  const real = electronMod.protocol as Record<string, unknown>;
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'registerSchemesAsPrivileged') {
        return () => void 0; // 宿主已 ready，无法再注册；无害忽略
      }
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
