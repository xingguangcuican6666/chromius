/**
 * vm 沙盒 —— 在宿主主进程里运行子应用的 main.js。
 *
 * 已在本机实测：vm.createContext + 虚拟 app + 作用域 ipcMain 可以跑通真实 main.js，
 * 并拿到隔离的 userData / app 名。
 *
 * 本文件不含任何 App 特有逻辑。
 */
import { BrowserWindow, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import { makeVirtualApp } from './virtual-app';
import { debug, debugEnabled } from './debug';
import { installAsyncProbe } from './async-probe';
import {
  isShimmedAddon,
  keymapShimUrl,
  makeKeymapFacade,
  resetKeymapOwner,
} from './addon-shims';
import { CACHE_DIR } from '../shared/paths';
import {
  ClientSpec,
  createVmWindow,
} from './clients';

export interface VmClientHandle {
  run(): void;
  dispose(): void;
}

/**
 * 构造子应用看到的 ipcMain。
 *
 * 通道名**不加前缀**：子应用的主进程和它自己的 renderer 是同一套代码，用的是
 * 同一个通道名（VS Code 系全部是 `vscode:xxx`）。加前缀会让主进程注册的 handler
 * 与 renderer 发出的请求对不上，表现为
 * `No handler registered for 'vscode:fetchShellEnv'`，然后窗口白屏。
 *
 * 也不能只挑几个方法转发：ipcMain 是一个 EventEmitter，子应用会用到
 * `removeListener` / `off` / `listenerCount` 等（VS Code 在窗口关闭时会调用
 * `removeListener` 解绑）。少一个方法就是一次
 * `TypeError: ipcMain.removeListener is not a function`，而且往往发生在启动
 * 链中间，直接把应用带崩。所以整体代理真实 ipcMain，方法全部绑定后返回。
 *
 * 额外记录本子应用注册过的东西，`dispose()` 时撤销。这很关键：同一个宿主里
 * kill 后重新 launch 同一 App 时，入口模块会重新求值并再次 `ipcMain.handle`
 * 同名通道，Electron 直接抛
 * `Attempted to register a second handler for 'vscode:fetchShellEnv'`，
 * 新实例当场崩掉、一个窗口都建不出来。
 *
 * 代价：两个子应用若用完全相同的通道名会互相覆盖。这是已知限制，比「所有应用
 * 都用不了」好得多；将来要彻底解决，需要按 webContents 路由而不是按通道名。
 */
function makeScopedIpcMain(_id: string): {
  facade: Record<string, unknown>;
  dispose: () => void;
} {
  const real = ipcMain as unknown as Record<string, unknown>;
  const handled = new Set<string>();
  const listeners: Array<{ event: string; fn: (...a: unknown[]) => void }> = [];

  const facade = new Proxy(real, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof v !== 'function') return v;

      if (prop === 'handle' || prop === 'handleOnce') {
        return (channel: string, ...rest: unknown[]) => {
          handled.add(channel);
          return (v as (...a: unknown[]) => unknown).apply(target, [channel, ...rest]);
        };
      }
      if (prop === 'on' || prop === 'once' || prop === 'addListener') {
        return (event: string, fn: (...a: unknown[]) => void, ...rest: unknown[]) => {
          listeners.push({ event, fn });
          return (v as (...a: unknown[]) => unknown).apply(target, [event, fn, ...rest]);
        };
      }
      return (v as (...a: unknown[]) => unknown).bind(target);
    },
  });

  return {
    facade,
    dispose() {
      const removeHandler = real['removeHandler'] as ((c: string) => void) | undefined;
      const removeListener = real['removeListener'] as
        | ((e: string, fn: (...a: unknown[]) => void) => void)
        | undefined;
      for (const ch of handled) {
        try {
          removeHandler?.call(real, ch);
        } catch {
          /* 已不存在 */
        }
      }
      for (const { event, fn } of listeners) {
        try {
          removeListener?.call(real, event, fn);
        } catch {
          /* 已不存在 */
        }
      }
      handled.clear();
      listeners.length = 0;
    },
  };
}

/**
 * 给子应用的窗口挂上诊断事件。
 *
 * 这些事件在 Electron 里默认**完全静默**，而「窗口建出来了但没有内容」的
 * 全部线索都在这里：
 *   - did-fail-load   ：主文档加载失败（协议 handler 缺失 → ERR_FAILED）
 *   - console-message ：子资源（脚本/样式）被 CSP 或协议拒绝
 *   - render-process-gone ：渲染进程崩溃
 * 没有它们，白屏窗口跟正常窗口在日志上毫无区别。
 *
 * 噪音也大（VS Code 系启动会打上百条 console-message），所以走 debug 开关。
 */
function attachDiagnostics(win: BrowserWindow, id: string): void {
  const wc = win.webContents;

  wc.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[chromius] ${id}: did-fail-load ${code} ${desc} url=${url}`);
  });
  wc.on('render-process-gone', (_e, details) => {
    console.error(`[chromius] ${id}: render-process-gone ${details.reason} exit=${details.exitCode}`);
  });

  if (!debugEnabled()) return;

  wc.on('console-message', (...args: unknown[]) => {
    // Electron 39 改成了 (event, details) 单对象形式，更早的是位置参数。两种都兼容。
    const d = args[1] as Record<string, unknown> | number;
    const obj = typeof d === 'object' && d !== null;
    const msg = obj ? (d['message'] as string) : (args[2] as string);
    const src = obj ? (d['sourceId'] as string) : (args[4] as string);
    const level = obj ? (d['level'] as string) : (args[1] as number);
    if (!msg) return;
    debug(
      `${id}: console[${level}] ${String(msg).slice(0, 300)}` +
        (src ? ` (${String(src).slice(0, 80)})` : ''),
    );
  });

  wc.on('did-finish-load', () => {
    debug(`${id}: did-finish-load url=${wc.getURL().slice(0, 100)}`);
    // 加载「成功」但内容可能仍是空白：资源被 CSP 或协议 handler 拒绝时，
    // 主文档照样 finish-load，只是 body 里什么都没有。bodyLen 是最快的判据。
    wc.executeJavaScript(
      `JSON.stringify({title: document.title, url: location.href,
         bodyLen: document.body ? document.body.innerHTML.length : -1,
         scripts: document.scripts.length})`,
    )
      .then((r: unknown) => debug(`${id}: dom=${r}`))
      .catch((e: Error) => debug(`${id}: dom probe failed: ${e.message}`));
  });
}

/**
 * 子应用看到的 session 视图。
 *
 * 只代理 `defaultSession.protocol` 的 handle/handleOnce，把 scheme 记进
 * `registeredSchemes`，以便 dispose 时撤销。其余一律透传——session 上的
 * webRequest / setPermission* 等 handler 是子应用自己的策略，重复注册在
 * Electron 里是覆盖语义（不抛错），无需处理。
 */
function makeVirtualSession(registeredSchemes: Set<string>): Record<string, unknown> {
  const realSession = require('electron').session as Record<string, unknown>;
  const defaultSession = realSession['defaultSession'] as Record<string, unknown>;
  const realProto = defaultSession['protocol'] as Record<string, unknown>;

  const protoProxy = new Proxy(realProto, {
    get(target, prop) {
      if (prop === 'handle' || prop === 'handleOnce') {
        const fn = Reflect.get(target, prop) as (s: string, h: unknown) => void;
        return (scheme: string, handler: unknown) => {
          registeredSchemes.add(scheme);
          return fn.call(target, scheme, handler);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });

  const defaultProxy = new Proxy(defaultSession, {
    get(target, prop) {
      if (prop === 'protocol') return protoProxy;
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });

  return new Proxy(realSession, {
    get(target, prop) {
      if (prop === 'defaultSession') return defaultProxy;
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/**
 * 子应用看到的 utilityProcess。
 *
 * VS Code 系的主进程用 `utilityProcess.fork()` 拉起 extension host、pty host、
 * shared process——每个都是独立的 Electron utility 进程，其生命周期**不会**随
 * 窗口关闭而结束。`kill` 一个 client 时若只关窗口，这些进程会一直留在宿主树里：
 *
 *   实测 antigravity 连续 3 次 launch + kill 后，宿主下堆了 9 个 NodeService
 *   utility 进程和 6 个 tsserver，PSS 从 ~700MB 涨到 3256MB。这恰好是本项目
 *   要消除的那类浪费，不能自己制造。
 *
 * 所以记录本 client fork 出来的进程，dispose 时逐个 kill。用 Proxy 而不是
 * 手写对象：utilityProcess 上还有 fork 之外的成员，必须全部透传。
 */
function makeScopedUtilityProcess(id: string): {
  facade: Record<string, unknown>;
  dispose: () => void;
} {
  const real = require('electron').utilityProcess as Record<string, unknown>;
  const forked: Array<{ kill?: () => boolean; pid?: number }> = [];

  const facade = new Proxy(real, {
    get(target, prop) {
      if (prop === 'fork') {
        const fn = Reflect.get(target, prop) as (...a: unknown[]) => unknown;
        return (...args: unknown[]) => {
          const child = fn.apply(target, args) as { kill?: () => boolean; pid?: number };
          if (child && typeof child === 'object') forked.push(child);
          return child;
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });

  return {
    facade,
    dispose() {
      for (const child of forked) {
        try {
          child.kill?.();
        } catch {
          /* 已退出 */
        }
      }
      forked.length = 0;
      debug(`${id}: killed forked utility processes`);
    },
  };
}

/** 构造子应用看到的 electron 模块替身。 */
function makeElectronFacade(
  spec: ClientSpec,
  virtualApp: Record<string, unknown>,
  scopedIpcMain: Record<string, unknown>,
  windows: BrowserWindow[],
  registeredSchemes: Set<string>,
  scopedUtility: Record<string, unknown>,
): Record<string, unknown> {
  return {
    app: virtualApp,
    ipcMain: scopedIpcMain,
    BrowserWindow: class extends BrowserWindow {
      constructor(opts: Record<string, unknown> = {}) {
        // 不强制 partition。vm 模式跑的是子应用自己的主进程，它会用
        // session.defaultSession.protocol 注册自己的协议（VS Code 系的
        // vscode-file:// 就是这样）。把窗口切到别的 partition，那些 handler
        // 就不在窗口的 session 里，loadURL 直接 ERR_FAILED(-2)。
        // vm 模式的存储隔离由虚拟 app 的 userData 路径负责，不靠 partition。
        const webPreferences = {
          ...(opts.webPreferences as Record<string, unknown> | undefined),
        };
        super({ ...opts, webPreferences });
        windows.push(this);
        // 子应用自己关窗后，注册表里不该再留着它，否则 status 会虚报。
        this.once('closed', () => {
          const i = windows.indexOf(this);
          if (i >= 0) windows.splice(i, 1);
        });
        attachDiagnostics(this, spec.id);
      }
    },
    // 其余按需透传真实模块
    // session 必须代理：VS Code 系通过 `session.defaultSession.protocol.handle`
    // 注册 vscode-file / vscode-webview 的 handler。这些 handler 挂在进程级的
    // defaultSession 上，kill 后重新 launch 会因重复注册 scheme 抛
    // `Failed to register protocol`，新实例直接起不来。代理记下注册过的 scheme，
    // dispose 时统一撤销。
    session: makeVirtualSession(registeredSchemes),
    // utilityProcess 必须代理：VS Code 系用它 fork extension host / pty host /
    // shared process，这些进程不会随窗口关闭而结束。详见 makeScopedUtilityProcess。
    utilityProcess: scopedUtility,
    shell: require('electron').shell,
    dialog: require('electron').dialog,
    Menu: require('electron').Menu,
    Tray: require('electron').Tray,
    nativeImage: require('electron').nativeImage,
    // protocol 必须走虚拟视图：子应用在 ready 后仍会调用 registerSchemesAsPrivileged，
    // 真实实现会抛错。虚拟 app 的 protocol getter 就是为此准备的。
    protocol: (virtualApp as Record<string, unknown>)['protocol'],
    screen: require('electron').screen,
    Notification: require('electron').Notification,
  };
}

/** 把 app 路径（可能是 asar 内部入口）解析为可 require 的绝对路径。 */
function resolveEntry(spec: ClientSpec): string | null {
  if (!spec.entry) return null;
  if (spec.appPath.endsWith('.asar')) {
    // Electron 的 require 支持 asar 路径：<asar>/<entry>
    return path.posix.join(spec.appPath, spec.entry.replace(/^\.\//, ''));
  }
  return path.resolve(spec.appPath, spec.entry);
}

export function startVmClient(
  spec: ClientSpec,
  rootDir: string,
  onShutdown: () => void,
  /** 子应用的窗口注册表：与 clients.ts 里 client.windows 是同一个数组，
   *  这样 status / removeClient 能看到子应用自己创建的窗口。 */
  windows: BrowserWindow[],
): VmClientHandle {
  const registeredSchemes = new Set<string>();
  const virtualApp = makeVirtualApp(spec, rootDir, registeredSchemes);
  const scopedIpc = makeScopedIpcMain(spec.id);
  const scopedUtility = makeScopedUtilityProcess(spec.id);
  const electronFacade = makeElectronFacade(
    spec,
    virtualApp,
    scopedIpc.facade,
    windows,
    registeredSchemes,
    scopedUtility.facade,
  );

  // 让虚拟 app 的 quit 关闭它自己的所有窗口
  (virtualApp as Record<string, unknown>)['_onQuit'] = () => {
    for (const w of windows) if (!w.isDestroyed()) w.close();
    onShutdown();
  };

  const entryAbs = resolveEntry(spec);
  const isEsm = entryAbs ? detectModuleSystem(spec, entryAbs) === 'esm' : false;

  /** 本次 launch 的序号：原生插件垫片用它给订阅归属。 */
  let owner = 0;

  const handle: VmClientHandle = {
    run() {
      if (!entryAbs) {
        throw new Error(`client ${spec.id}: no entry`);
      }
      const source = readEntrySource(entryAbs);
      if (source === null) throw new Error(`client ${spec.id}: entry not found: ${entryAbs}`);

      owner = ++launchSeq;

      if (isEsm) {
        // ESM：vm.SourceTextModule 在 Electron 里不可用，改用模块解析钩子 + 动态 import。
        debug(`${spec.id}: importing ESM entry ${entryAbs}`);
        // 子应用入口常见 `main(){ this.startup() }`（未 await async startup），
        // 内部某个 await 永远不 resolve 时外部看不到任何错误。只在调试模式下
        // 装探针，把仍 pending 的 Promise 创建栈打出来。
        if (debugEnabled()) installAsyncProbe(8000, spec.id);
        runEsmClient(spec, entryAbs, electronFacade, owner)
          .then(() => {
            debug(`${spec.id}: ESM entry evaluation finished`);
          })
          .catch((e) => {
            console.error(`[chromius] ESM client ${spec.id} failed: ${e?.message ?? e}`);
          });
        return;
      }

      const sandbox = buildSandbox(spec, entryAbs, electronFacade, windows, owner);
      vm.createContext(sandbox);
      vm.runInContext(source, sandbox, { filename: entryAbs, displayErrors: true });
    },
    dispose() {
      for (const w of windows) if (!w.isDestroyed()) w.close();
      // 撤销本子应用注册的 ipcMain handler / listener。不做这一步，同一宿主里
      // kill 后重新 launch 会在注册同名通道时抛
      // `Attempted to register a second handler`，新实例直接起不来。
      scopedIpc.dispose();
      // kill 本 client fork 出来的 utility 进程（extension host / pty host /
      // shared process）。不杀的话它们会一直挂在宿主下，把内存越堆越高。
      scopedUtility.dispose();
      // 撤销挂在真实 app 上的监听器、protocol handler，并清理子应用遗留的
      // 实例锁文件 / IPC socket。详见 virtual-app.ts 的 _dispose。
      const disposeApp = (virtualApp as Record<string, unknown>)['_dispose'];
      if (typeof disposeApp === 'function') (disposeApp as () => void)();
      else console.error(`[chromius] ${spec.id}: _dispose missing (virtual app not a proxy?)`);
      // 摘掉原生插件垫片里属于本轮的订阅。
      resetKeymapOwner(owner);
    },
  };
  return handle;
}

/** 判断入口是 ESM 还是 CJS。看 package.json 的 "type" 与文件后缀。 */
function detectModuleSystem(spec: ClientSpec, entryAbs: string): 'esm' | 'cjs' {
  if (/\.mjs$/.test(entryAbs)) return 'esm';
  if (/\.cjs$/.test(entryAbs)) return 'cjs';
  // 读应用 package.json 的 type 字段
  try {
    const pkgPath = spec.appPath.endsWith('.asar')
      ? path.posix.join(spec.appPath, 'package.json')
      : path.join(spec.appPath, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.type === 'module') return 'esm';
  } catch {
    /* 读不到就按 CJS 处理 */
  }
  return 'cjs';
}

/**
 * 以 ESM 方式运行子应用入口。
 *
 * 做法：注册一个 Module 解析钩子，把子应用里的 `import 'electron'` 重定向到我们
 * 生成的一个包装模块——它从 globalThis 读取「虚拟 electron 视图」（app 是虚拟的，
 * 其余 API 是真实的）。真实的 ESM 由 Node 自己的 loader 处理，因此 import 语法、
 * import.meta、顶层 await 全部原生可用。
 *
 * 注意：钩子是进程级的，但重定向的是**模块说明符 'electron'**——所有 ESM 子应用
 * 都会经过它；我们用一个「当前正在加载哪个 client」的全局栈，让包装模块按当前
 * 子应用返回对应的视图，从而互不干扰。
 */
const esmViewStack: Array<Record<string, unknown>> = [];
/** 串行化 ESM 入口加载：包装模块从全局读取视图，并发会串味。 */
let esmLoadChain: Promise<unknown> = Promise.resolve();
/** 每次 launch 递增，用于给入口 URL 加 query 以绕开永不失效的 ESM 缓存。 */
let esmRunSeq = 0;
/** 当前正在加载的那一轮的序号；解析钩子用它给包装模块 URL 加 query。 */
let currentEsmRun = 0;
/**
 * 当前正在加载的那一轮的「归属序号」。与 currentEsmRun 分开：前者只用于
 * 绕开 ESM 缓存，后者必须与 `run()` 里 `owner = ++launchSeq` 的值一致——
 * dispose 时按它摘除原生插件垫片里的订阅，两边对不上就摘不掉。
 */
let currentOwner = 0;
/**
 * 全局 launch 序号，ESM 与 CJS 两条路径共用。
 *
 * 原生插件垫片用它给订阅打「归属」标记：kill 一个 client 时只能摘掉它自己的
 * 订阅，不能误伤同一宿主里其它 App 的键盘布局监听。
 */
let launchSeq = 0;

function runEsmClient(
  spec: ClientSpec,
  entryAbs: string,
  electronFacade: Record<string, unknown>,
  /** 本次 launch 的归属序号，与 dispose 时传给 resetKeymapOwner 的值一致。 */
  owner: number,
): Promise<void> {
  const Module = require('module') as typeof import('module');
  const realElectron = require('electron');

  // 构造「虚拟 electron 视图」。facade 里的每个键都优先返回（app / ipcMain /
  // protocol / BrowserWindow 都是子应用专属视图），其余键透传真实模块。
  //
  // 关键：默认导出（`import electron from 'electron'`）拿到的就是 view 本身，
  // 子应用常用 `electron.BrowserWindow` 这种写法。VS Code 系主进程正是如此
  // （`import vb from 'electron'` + `new vb.BrowserWindow(...)`）。若这里不
  // 返回 facade 的 BrowserWindow，窗口会由真实类创建，绕过 partition 与注册表。
  const view = new Proxy(realElectron as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(electronFacade, prop)) {
        return electronFacade[prop];
      }
      return Reflect.get(target, prop);
    },
  }) as Record<string, unknown>;

  installEsmHookOnce(Module);

  // 串行加载：在轮到本 client 之前，其他 ESM 入口不会并发写全局视图。
  const run = esmLoadChain.then(async () => {
    // 每次 launch 用一个新的序号。入口 URL 和它 import 到的包装模块 URL 都要
    // 带上它，理由见下方注释。
    currentEsmRun = ++esmRunSeq;
    currentOwner = owner;
    (globalThis as Record<string, unknown>)['__CHROMIUS_VIEW__'] = view;
    esmViewStack.push(view);
    try {
      // 给入口 URL 加一个每次启动都不同的 query，强制 ESM 缓存失效。
      //
      // Node 的 ESM 模块缓存按 URL 索引且**永不失效**：同一个宿主里第二次
      // launch 同一个 App 时，`import(entryAbs)` 直接返回第一次的模块对象，
      // 顶层代码不再执行——表现为「attached 成功但什么都没发生」。
      // 子应用被 kill 后重新拉起是完全正常的操作，必须能重跑。
      await import(`${pathToFileURL(entryAbs).href}?chromius-run=${currentEsmRun}`);
    } finally {
      // 入口加载完成（其顶层代码已执行）后，恢复上一个视图，
      // 让仍在运行的其它 client 的动态 import 拿到自己的视图。
      esmViewStack.pop();
      (globalThis as Record<string, unknown>)['__CHROMIUS_VIEW__'] =
        esmViewStack[esmViewStack.length - 1];
    }
  });
  esmLoadChain = run.catch(() => void 0);
  return run;
}

let esmHookInstalled = false;
function installEsmHookOnce(Module: typeof import('module')): void {
  if (esmHookInstalled) return;
  esmHookInstalled = true;

  // 包装模块必须落在**用户可写**的目录：安装后 chromius 在 /usr/share 下，
  // 普通用户无法在那里写文件。缓存目录天然可写，且内容随 electron 版本变化，
  // 用版本号做文件名可避免旧版本的残留文件被误用。
  const wrapperPath = path.join(
    CACHE_DIR,
    `esm-electron-wrapper-${process.versions.electron || process.versions.node}.mjs`,
  );
  // 生成包装模块（如果不存在或内容过期）
  const wrapperSource = buildEsmWrapperSource();
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const cur = fs.readFileSync(wrapperPath, 'utf8');
    if (cur !== wrapperSource) fs.writeFileSync(wrapperPath, wrapperSource);
  } catch {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(wrapperPath, wrapperSource);
  }

  const ModuleR = Module as unknown as {
    registerHooks(hooks: {
      resolve: (
        specifier: string,
        context: { parentURL?: string } | undefined,
        nextResolve: (s: string, c: unknown) => unknown,
      ) => unknown;
    }): void;
  };
  ModuleR.registerHooks({
    resolve(
      specifier: string,
      context: { parentURL?: string } | undefined,
      nextResolve: (s: string, c: unknown) => unknown,
    ) {
      // 只重定向「从子应用代码发起」的 import。宿主自己的 require('electron')
      // 必须拿到真实模块，否则会形成 require(esm) 循环并破坏宿主。
      if (specifier === 'electron' && isClientImport(context?.parentURL)) {
        // 包装模块也带上本轮的序号。它在顶层执行
        //   `const view = globalThis.__CHROMIUS_VIEW__`
        // 并把这个引用固定下来；若沿用同一个 URL，第二次 launch 时 Node 直接
        // 返回缓存的那个模块，子应用 import 到的仍是**第一次**的 view——新窗口
        // 会创建在已废弃的旧注册表里，status 永远显示 0 个窗口。
        return {
          url: `${pathToFileURL(wrapperPath).href}?chromius-run=${currentEsmRun}`,
          shortCircuit: true,
        };
      }

      // 原生插件的幂等垫片。理由见 addon-shims.ts：这类插件的注册函数在
      // 进程级非幂等，第二次 launch 时重复调用会直接 abort 整个宿主。
      //
      // 必须解析出**真实**路径（子应用可能有自己的 node_modules 副本），再把
      // 它作为参数交给垫片。这里不能用 nextResolve：registerHooks 的钩子是
      // 同步的，而 nextResolve 的结果在 Electron 里可能是个 Promise。用
      // createRequire 从发起 import 的文件出发做 CJS 解析，得到的就是包入口。
      if (isShimmedAddon(specifier) && isClientImport(context?.parentURL)) {
        try {
          const from = context?.parentURL;
          // parentURL 可能带 chromius 自己加的 `?chromius-run=N`。createRequire
          // 对字符串参数按**路径**处理，会把 query 当成文件名的一部分；传 URL
          // 对象才会正确解析出目录。解析结果只看目录，所以 query 无害，但用
          // URL 对象更稳妥。
          const req = createRequire(from && from.startsWith('file:') ? new URL(from) : __filename);
          const realPath = req.resolve(specifier);
          return {
            url: keymapShimUrl(pathToFileURL(realPath).href, currentOwner),
            shortCircuit: true,
          };
        } catch {
          /* 解析不到就走正常流程，让 Node 自己报错 */
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

/** 判断某个 import 是否来自「子应用」（而不是 chromius 自身代码）。 */
function isClientImport(parentURL: string | undefined): boolean {
  if (!parentURL) return false;
  if (!parentURL.startsWith('file:')) return false;
  // chromius 自身代码全在 <安装根>/shell、<安装根>/daemon 等子目录下。
  // 只排除安装根这一个目录：不能把它的父目录也算进来——安装后父目录是
  // /usr/share，那样会把 /usr/share/<某应用> 误判成 chromius 自己的代码。
  const installRoot = path.resolve(__dirname, '..');
  let p: string;
  try {
    p = require('url').fileURLToPath(parentURL);
  } catch {
    return false;
  }
  return !p.startsWith(installRoot + path.sep);
}

/** 包装模块源码：从 globalThis 取当前视图并按 electron 的具名导出重新导出。
 *
 * ESM 的具名导出必须是静态可分析的，所以这里把 electron 运行时导出的全部名称
 * 逐一列出（用 `export const name = view.name`）。若某个名称在视图里不存在，
 * 会得到 undefined —— 但真实模块里一定存在（视图是真实 electron 的浅拷贝）。
 */
function buildEsmWrapperSource(): string {
  // 由 installEsmHookOnce 在运行时填入（来自 require('electron') 的属性名）
  const realElectron = require('electron') as Record<string, unknown>;
  // 用 getOwnPropertyNames 而非 Object.keys：避免触发 getter 求值。
  const names = Object.getOwnPropertyNames(realElectron).filter((k) => {
    if (k === 'default' || k === '__esModule') return false;
    // 只导出合法的 JS 标识符
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
  });
  const lines = names.map((n) => `export const ${n} = view[${JSON.stringify(n)}];`);
  return `// 由 chromius 生成：把 globalThis.__CHROMIUS_VIEW__ 暴露为 electron 模块
const view = globalThis.__CHROMIUS_VIEW__;
${lines.join('\n')}
export default view;
`;
}

function readEntrySource(entryAbs: string): string | null {
  try {
    // asar 路径在 Electron 的 Node 里可直接 fs 读
    return fs.readFileSync(entryAbs, 'utf8');
  } catch {
    return null;
  }
}

function buildSandbox(
  spec: ClientSpec,
  entryAbs: string,
  electronFacade: Record<string, unknown>,
  windows: BrowserWindow[],
  owner: number,
): Record<string, unknown> {
  // 关键：子应用自己 require 的 node 模块要基于它自己的目录解析
  // （node_modules、asar 内路径）。用 Module.createRequire。
  const appRequire = createRequire(entryAbs);

  const wrappedRequire = (mod: string) => {
    if (mod === 'electron') return electronFacade;
    // 原生插件的幂等垫片（CJS 路径）。理由见 addon-shims.ts：这类插件的注册
    // 函数在进程级非幂等，第二次 launch 重复调用会 abort 整个宿主。
    if (isShimmedAddon(mod)) {
      const realPath = appRequire.resolve(mod);
      const real = appRequire(realPath) as Record<string, unknown>;
      return makeKeymapFacade(real, realPath, owner);
    }
    return appRequire(mod);
  };

  const sandbox: Record<string, unknown> = {
    require: wrappedRequire,
    module: { exports: {} },
    exports: {},
    __dirname: path.dirname(entryAbs),
    __filename: entryAbs,
    console,
    process: makeProcessFacade(spec),
    Buffer,
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval,
    setImmediate,
    URL,
    TextEncoder,
    TextDecoder,
  };
  sandbox['global'] = sandbox;
  sandbox['globalThis'] = sandbox;
  void windows;
  void createVmWindow;
  return sandbox;
}

function makeProcessFacade(spec: ClientSpec): Record<string, unknown> {
  return {
    argv: [spec.realBinary, ...spec.argv],
    cwd: () => spec.cwd,
    env: { ...process.env, ...spec.env },
    platform: process.platform,
    arch: process.arch,
    version: process.version,
    versions: process.versions,
    execPath: spec.realBinary,
    pid: process.pid,
    exit: (code?: number) => {
      console.warn(`[chromius] ${spec.id} called process.exit(${code ?? 0})`);
    },
    on: process.on.bind(process),
    once: process.once.bind(process),
    nextTick: process.nextTick.bind(process),
  };
}
