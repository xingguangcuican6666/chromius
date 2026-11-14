/**
 * 原生插件的进程级垫片。
 *
 * 共享宿主里「同一个 App 第二次 launch」会重新求值它的入口模块，于是它会再次
 * 调用原生插件暴露的注册函数。有些插件的注册函数是**进程级且非幂等**的：
 *
 *   native-keymap 的 onDidChangeKeyboardLayout() 每次调用都执行
 *   napi_add_env_cleanup_hook()，而 Node 对「同一 (env, fun) 注册两次」的处理
 *   是 Assertion failed 直接 abort 进程——不是可捕获的 JS 异常。
 *
 * 实测：antigravity-ide 第二次 launch 必崩在
 *   NativeBinding.onDidChangeKeyboardLayout (native-keymap/index.js:43)
 * 整个宿主连同其中其它 App 一起死。这类问题无法靠 try/catch 或清理句柄解决，
 * 只能让原生侧的注册**在整个进程生命周期里只发生一次**。
 *
 * 解法：宿主接管该模块的加载，返回一个垫片：
 *   - 原生侧第一次调用时注册，之后不再碰原生注册函数；
 *   - JS 侧把每个订阅者的回调存进注册表，由垫片自己分发；
 *   - 订阅按「归属者」（launch 序号）标记，kill 时只摘掉自己的。
 *
 * 注册表挂在 globalThis 上而不是模块作用域里：ESM 垫片（生成在缓存目录）与
 * CJS 垫片（宿主构造的对象）是两份代码，但必须共享同一个「原生是否已注册」的
 * 判断，否则一个 App 走 ESM、另一个走 CJS 时仍会各自注册一次并 abort。
 * 同一个原生模块由**真实路径**区分——不同 App 可能带不同的 native-keymap 副本。
 *
 * 本文件不含任何 App 名相关逻辑：判断依据是**模块名**，而 native-keymap 是
 * 整个 VS Code 系（Code / Cursor / Kiro / Antigravity …）共用的微软官方插件。
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CACHE_DIR } from '../shared/paths';

/** 需要垫片的模块名。 */
const SHIMMED_ADDONS = new Set(['native-keymap']);

const KEYMAP_SHIM_FILE = 'native-keymap-shim.mjs';

/** 该说明符是否需要宿主接管。 */
export function isShimmedAddon(specifier: string): boolean {
  return SHIMMED_ADDONS.has(specifier);
}

/** globalThis 上注册表的键。 */
const REGISTRY_KEY = '__CHROMIUS_ADDON_REGISTRY__';

interface RegistryEntry {
  /** 原生侧是否已注册。整个进程、每个真实模块只允许为 true 一次。 */
  registered: boolean;
  /** 订阅者：{ owner, cb }。owner 是 launch 序号，kill 时按它摘除。 */
  subs: Array<{ owner: number; cb: () => void }>;
}

type Registry = Record<string, RegistryEntry>;

function registry(): Registry {
  const g = globalThis as Record<string, unknown>;
  let r = g[REGISTRY_KEY] as Registry | undefined;
  if (!r) {
    r = {};
    g[REGISTRY_KEY] = r;
  }
  return r;
}

/** 取（或建）某个真实模块的注册表项。 */
export function keymapEntry(realPath: string): RegistryEntry {
  const r = registry();
  let e = r[realPath];
  if (!e) {
    e = { registered: false, subs: [] };
    r[realPath] = e;
  }
  return e;
}

/**
 * 垫片源码。URL 参数：
 *   real  —— 真实模块（包 index.js）的 file URL
 *   owner —— 本次 launch 的序号，kill 时据此摘除订阅
 *
 * 用 `import.meta.url` 取参数而不是写死路径：同一个缓存文件可以被不同 App 的
 * 不同 native-keymap 副本复用，参数不同就是不同的模块实例，互不干扰。
 */
function buildKeymapShimSource(): string {
  return `// 由 chromius 生成：native-keymap 的进程级幂等垫片。见 src/shell/addon-shims.ts
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const params = new URL(import.meta.url).searchParams;
const realUrl = params.get('real');
const realPath = fileURLToPath(realUrl);
const owner = Number(params.get('owner') || 0);

// 走包自己的 index.js（不是直接 require .node）：保留它的 Debug 回退逻辑。
const native = createRequire(realPath)(realPath);

// 注册表由宿主的 addon-shims.ts 维护；两个方向（ESM/CJS）共享同一份。
const KEY = '__CHROMIUS_ADDON_REGISTRY__';
const g = globalThis;
if (!g[KEY]) g[KEY] = {};
if (!g[KEY][realPath]) g[KEY][realPath] = { registered: false, subs: [] };
const entry = g[KEY][realPath];

export function getKeyMap() {
  return native.getKeyMap();
}

export function getCurrentKeyboardLayout() {
  return native.getCurrentKeyboardLayout();
}

export function isISOKeyboard() {
  return native.isISOKeyboard();
}

export function onDidChangeKeyboardLayout(cb) {
  entry.subs.push({ owner, cb });
  if (entry.registered) return;
  entry.registered = true;
  native.onDidChangeKeyboardLayout(() => {
    // 复制一份再遍历：回调里可能又注册/摘除订阅。
    for (const s of entry.subs.slice()) {
      try {
        s.cb();
      } catch (e) {
        console.error('[chromius] native-keymap subscriber threw:', e);
      }
    }
  });
}

export default {
  getKeyMap,
  getCurrentKeyboardLayout,
  isISOKeyboard,
  onDidChangeKeyboardLayout,
};
`;
}

/** 确保垫片文件存在且是最新的；返回其路径。 */
export function ensureKeymapShim(): string {
  const p = path.join(CACHE_DIR, KEYMAP_SHIM_FILE);
  const src = buildKeymapShimSource();
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    let cur: string | null = null;
    try {
      cur = fs.readFileSync(p, 'utf8');
    } catch {
      cur = null;
    }
    if (cur !== src) fs.writeFileSync(p, src);
  } catch (e) {
    console.error(`[chromius] cannot write native-keymap shim: ${String(e)}`);
  }
  return p;
}

/** 垫片模块的 URL（带真实模块路径与本次 launch 序号）。 */
export function keymapShimUrl(realUrl: string, owner: number): string {
  return (
    `${pathToFileURL(ensureKeymapShim()).href}` +
    `?real=${encodeURIComponent(realUrl)}&owner=${owner}`
  );
}

// —— CJS 路径的垫片 ——
//
// CJS 子应用走宿主自己的 require，不需要生成文件：宿主直接构造一个等价对象。

/** 把真实的 native-keymap 包成一个幂等视图。 */
export function makeKeymapFacade(
  real: Record<string, unknown>,
  realPath: string,
  owner: number,
): Record<string, unknown> {
  const entry = keymapEntry(realPath);
  return {
    getKeyMap: () => (real['getKeyMap'] as () => unknown)(),
    getCurrentKeyboardLayout: () => (real['getCurrentKeyboardLayout'] as () => unknown)(),
    isISOKeyboard: () => (real['isISOKeyboard'] as () => unknown)(),
    onDidChangeKeyboardLayout: (cb: () => void) => {
      entry.subs.push({ owner, cb });
      if (entry.registered) return;
      entry.registered = true;
      (real['onDidChangeKeyboardLayout'] as (f: () => void) => void)(() => {
        for (const s of entry.subs.slice()) {
          try {
            s.cb();
          } catch (e) {
            console.error('[chromius] native-keymap subscriber threw:', e);
          }
        }
      });
    },
  };
}

/** 摘掉某个 launch 遗留的全部订阅（ESM 与 CJS 两条路径都清）。 */
export function resetKeymapOwner(owner: number): void {
  for (const entry of Object.values(registry())) {
    for (let i = entry.subs.length - 1; i >= 0; i--) {
      if (entry.subs[i].owner === owner) entry.subs.splice(i, 1);
    }
  }
}
