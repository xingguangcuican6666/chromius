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
import { makeVirtualApp } from './virtual-app';
import { CACHE_DIR } from '../shared/paths';
import {
  ClientSpec,
  createVmWindow,
  partitionFor,
} from './clients';

export interface VmClientHandle {
  run(): void;
  dispose(): void;
}

/** 创建作用域化 ipcMain：所有通道自动加 "<id>:" 前缀。 */
function makeScopedIpcMain(id: string): Record<string, unknown> {
  const prefix = (ch: string) => `${id}:${ch}`;
  return {
    handle(channel: string, listener: (...args: unknown[]) => unknown) {
      ipcMain.handle(prefix(channel), listener as never);
    },
    handleOnce(channel: string, listener: (...args: unknown[]) => unknown) {
      ipcMain.handleOnce(prefix(channel), listener as never);
    },
    on(channel: string, listener: (...args: unknown[]) => unknown) {
      ipcMain.on(prefix(channel), listener as never);
    },
    once(channel: string, listener: (...args: unknown[]) => unknown) {
      ipcMain.once(prefix(channel), listener as never);
    },
    removeHandler(channel: string) {
      ipcMain.removeHandler(prefix(channel));
    },
    removeAllListeners(channel: string) {
      ipcMain.removeAllListeners(prefix(channel));
    },
  };
}

/** 构造子应用看到的 electron 模块替身。 */
function makeElectronFacade(
  spec: ClientSpec,
  virtualApp: Record<string, unknown>,
  scopedIpcMain: Record<string, unknown>,
  windows: BrowserWindow[],
): Record<string, unknown> {
  return {
    app: virtualApp,
    ipcMain: scopedIpcMain,
    BrowserWindow: class extends BrowserWindow {
      constructor(opts: Record<string, unknown> = {}) {
        const webPreferences = {
          ...(opts.webPreferences as Record<string, unknown> | undefined),
          partition: partitionFor(spec.id),
        };
        super({ ...opts, webPreferences });
        windows.push(this);
      }
    },
    // 其余按需透传真实模块
    session: require('electron').session,
    shell: require('electron').shell,
    dialog: require('electron').dialog,
    Menu: require('electron').Menu,
    Tray: require('electron').Tray,
    nativeImage: require('electron').nativeImage,
    protocol: require('electron').protocol,
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
): VmClientHandle {
  const windows: BrowserWindow[] = [];
  const virtualApp = makeVirtualApp(spec, rootDir);
  const scopedIpcMain = makeScopedIpcMain(spec.id);
  const electronFacade = makeElectronFacade(spec, virtualApp, scopedIpcMain, windows);

  // 让虚拟 app 的 quit 关闭它自己的所有窗口
  (virtualApp as Record<string, unknown>)['_onQuit'] = () => {
    for (const w of windows) if (!w.isDestroyed()) w.close();
    onShutdown();
  };

  const entryAbs = resolveEntry(spec);
  const isEsm = entryAbs ? detectModuleSystem(spec, entryAbs) === 'esm' : false;

  const handle: VmClientHandle = {
    run() {
      if (!entryAbs) {
        throw new Error(`client ${spec.id}: no entry`);
      }
      const source = readEntrySource(entryAbs);
      if (source === null) throw new Error(`client ${spec.id}: entry not found: ${entryAbs}`);

      if (isEsm) {
        // ESM：vm.SourceTextModule 在 Electron 里不可用，改用模块解析钩子 + 动态 import。
        runEsmClient(spec, entryAbs, virtualApp as Record<string, unknown>, scopedIpcMain).catch(
          (e) => {
            console.error(`[chromius] ESM client ${spec.id} failed: ${e?.message ?? e}`);
          },
        );
        return;
      }

      const sandbox = buildSandbox(spec, entryAbs, electronFacade, windows);
      vm.createContext(sandbox);
      vm.runInContext(source, sandbox, { filename: entryAbs, displayErrors: true });
    },
    dispose() {
      for (const w of windows) if (!w.isDestroyed()) w.close();
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

function runEsmClient(
  spec: ClientSpec,
  entryAbs: string,
  virtualApp: Record<string, unknown>,
  scopedIpcMain: Record<string, unknown>,
): Promise<void> {
  const Module = require('module') as typeof import('module');
  const realElectron = require('electron');

  // 构造「虚拟 electron 视图」：app / ipcMain / protocol 被替换，其余透传。
  // 不用展开运算符：electron 的部分导出是 getter，展开会提前求值甚至抛错。
  const virtualAppRec = virtualApp as Record<string, unknown>;
  const view = new Proxy(realElectron as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop === 'app') return virtualApp;
      if (prop === 'ipcMain') return scopedIpcMain;
      // 顶层 protocol 也要用虚拟视图（子应用常写 import { protocol } from 'electron'）
      if (prop === 'protocol') return virtualAppRec['protocol'];
      return Reflect.get(target, prop);
    },
  }) as Record<string, unknown>;

  installEsmHookOnce(Module);

  // 串行加载：在轮到本 client 之前，其他 ESM 入口不会并发写全局视图。
  const run = esmLoadChain.then(async () => {
    (globalThis as Record<string, unknown>)['__CHROMIUS_VIEW__'] = view;
    esmViewStack.push(view);
    try {
      await import(entryAbs);
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
        return { url: require('url').pathToFileURL(wrapperPath).href, shortCircuit: true };
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
): Record<string, unknown> {
  // 关键：子应用自己 require 的 node 模块要基于它自己的目录解析
  // （node_modules、asar 内路径）。用 Module.createRequire。
  const { createRequire } = require('module') as typeof import('module');
  const appRequire = createRequire(entryAbs);

  const wrappedRequire = (mod: string) => {
    if (mod === 'electron') return electronFacade;
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
