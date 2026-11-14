/**
 * 通用 Electron App 发现。
 *
 * 关键原则：**零逐 App 硬编码**。我们只依赖 Electron 打包的通用结构：
 *   <dir>/<binary>            ← 任何 Electron App 都有
 *   <dir>/resources/app.asar  ← 或 resources/app/package.json
 *   <dir>/resources/app-update.yml (可选)
 *
 * id/名称/入口全部从 package.json 读取，版本来自二进制自身。
 */
import * as fs from 'fs';
import * as path from 'path';
import { DetectedApp } from './protocol';
import { CACHE_DIR, VERSION_CACHE } from './paths';

/** 读取 asar 里的 package.json。Electron 有内置 asar 支持，但这里在纯 Node 下运行，
 * 所以在没有 electron 的地方自己解析 asar header。 */
export function readAsarPackageJson(asarPath: string): Record<string, unknown> | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(asarPath, 'r');
    const size = fs.fstatSync(fd).size;
    // asar 格式:
    //   @0  uint32 = 4            (pickle 大小字段自身的长度)
    //   @4  uint32 = headerSize+4
    //   @8  uint32 = headerSize
    //   @12 uint32 = headerSize   (实际字符串长度)
    //   @16 起为 JSON header；数据区从 16+headerSize 开始
    const HEADER_OFFSET = 16;
    const head = Buffer.alloc(HEADER_OFFSET);
    fs.readSync(fd, head, 0, HEADER_OFFSET, 0);
    const headerSize = head.readUInt32LE(12);
    if (headerSize <= 0 || 16 + headerSize > size || headerSize > 64 * 1024 * 1024) return null;
    const headerBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuf, 0, headerSize, HEADER_OFFSET);
    // header 是 JSON 字符串，取第一个 '{' 到最后一个 '}'
    const s = headerBuf.toString('utf8');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end < 0) return null;
    const header = JSON.parse(s.slice(start, end + 1));
    const files = header?.files;
    const pkg = files?.['package.json'];
    if (!pkg) return null;
    if (pkg.unpacked === true) {
      // package.json 被抽出到 app.asar.unpacked
      const unpacked = path.join(asarPath + '.unpacked', 'package.json');
      if (fs.existsSync(unpacked)) {
        return JSON.parse(fs.readFileSync(unpacked, 'utf8'));
      }
      return null;
    }
    // 内联在 asar 数据区。
    // asar 的 offset 规则（见 @electron/asar）：
    //   - 有 offset 字段（可能是字符串，大整数安全）→ 直接用
    //   - 无 offset 字段 → 紧跟「上一个文件」的数据之后（顺序累计）
    // 因此需要按 header 的深度优先顺序遍历所有文件，累计无 offset 时的位置。
    const sizeNum = Number(pkg.size);
    if (!Number.isFinite(sizeNum) || sizeNum <= 0) return null;
    const offsetNum = resolveAsarOffset(files, pkg);
    if (offsetNum === null) return null;
    const dataStart = HEADER_OFFSET + headerSize;
    const content = Buffer.alloc(sizeNum);
    fs.readSync(fd, content, 0, sizeNum, dataStart + offsetNum);
    // executable 文件可能带 `#!/usr/bin/env node` shebang 前缀，跳过它再解析 JSON
    const text = content.toString('utf8');
    const jsonStart = text.indexOf('{');
    return JSON.parse(jsonStart > 0 ? text.slice(jsonStart) : text);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** asar 里没有 offset 字段的文件，其数据紧跟在上一个文件之后。按 header 的
 * 深度优先遍历顺序（与 @electron/asar 一致）累计偏移，找到目标 node 的位置。 */
function resolveAsarOffset(files: Record<string, unknown>, target: unknown): number | null {
  let running = 0;
  let found: number | null = null;
  const walk = (node: Record<string, unknown>): void => {
    if (found !== null) return;
    if (node === target) {
      found = typeof node.offset !== 'undefined' ? Number(node.offset) : running;
      return;
    }
    if (node.files) {
      for (const child of Object.values(node.files as Record<string, unknown>)) {
        walk(child as Record<string, unknown>);
        if (found !== null) return;
      }
      return;
    }
    // 叶子文件：定位并占据数据
    if (typeof node.size !== 'undefined') {
      if (typeof node.offset !== 'undefined') running = Number(node.offset);
      running += Number(node.size) || 0;
    }
  };
  walk({ files } as Record<string, unknown>);
  return found;
}

/** 从二进制自身探测 Electron 主版本（决定能否进共享宿主）。结果缓存。
 *
 * 不 exec 二进制：`--version` 在很多打包 App 上会启动 UI 或输出 Node 版本。
 * 改为读取二进制内的 "Chrome/XXX." 字符串——Electron 把 Chromium 版本编译进去了。
 * Chrome 主版本与 Electron 主版本的映射由 Electron 官方 release 决定，但我们只需要
 * 判断「能不能跟同一 Electron 大版本的东西互相加载」，所以直接用 Electron 版本字符串
 * "Electron/XX." 更准确；缺失时退回 Chrome 主版本。 */
export function detectElectronMajor(binary: string): string {
  let cache: Record<string, { mtimeMs: number; major: string }> = {};
  try {
    cache = JSON.parse(fs.readFileSync(VERSION_CACHE, 'utf8'));
  } catch {
    /* 无缓存 */
  }
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(binary).mtimeMs;
  } catch {
    return '0';
  }
  const hit = cache[binary];
  if (hit && hit.mtimeMs === mtimeMs) return hit.major;

  let major = scanBinaryVersion(binary);

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    cache[binary] = { mtimeMs, major };
    fs.writeFileSync(VERSION_CACHE, JSON.stringify(cache, null, 2));
  } catch {
    /* 缓存写失败无所谓 */
  }
  return major;
}

/** 流式扫描二进制，找 "Electron/<major>." 或 "Chrome/<major>."，返回主版本。 */
function scanBinaryVersion(binary: string): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(binary, 'r');
    const size = fs.statSync(binary).size;
    const CHUNK = 8 * 1024 * 1024;
    const OVERLAP = 64; // 跨 chunk 的关键字最多这么长
    let carry = Buffer.alloc(0);
    let electronMajor: string | null = null;
    let chromeMajor: string | null = null;
    for (let pos = 0; pos < size; pos += CHUNK) {
      const len = Math.min(CHUNK, size - pos);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      const hay = carry.length ? Buffer.concat([carry, buf]) : buf;
      const text = hay.toString('latin1');
      if (!electronMajor) {
        const m = text.match(/Electron\/(\d+)\./);
        if (m) electronMajor = m[1];
      }
      if (!chromeMajor) {
        const m = text.match(/Chrome\/(\d+)\./);
        if (m) chromeMajor = m[1];
      }
      if (electronMajor && chromeMajor) break;
      carry = hay.subarray(Math.max(0, hay.length - OVERLAP));
    }
    // Electron 主版本 > 0 才可信；Chrome 主版本也是有效信号
    if (electronMajor && electronMajor !== '0') return electronMajor;
    // 以 Chrome 主版本作为兜底标识（在同机不会碰撞）
    return chromeMajor ? `chrome-${chromeMajor}` : '0';
  } catch {
    return '0';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** 在 resources 下找应用载荷。会向上找最多两级（覆盖 app/Postman 这类嵌套布局）。 */
function findAppPayload(binaryDir: string): string | null {
  const bases = [binaryDir, path.join(binaryDir, '..'), path.join(binaryDir, '..', '..')];
  for (const base of bases) {
    const candidates = [
      path.join(base, 'resources', 'app.asar'),
      path.join(base, 'resources', 'app'),
      path.join(base, 'app.asar'),
      path.join(base, 'app'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory() === !c.endsWith('.asar')) {
        return path.resolve(c);
      }
    }
  }
  return null;
}

/**
 * 判断一个 App 是否自带「不能安全共享宿主」的原生 `.node` 模块。
 *
 * **故意只看解包目录，不扫 `appPath` 本身。** 这个函数的结果在 daemon / shell /
 * cli 三处都是**硬拒绝**，所以判据必须保守：
 *
 *   - asar 包把原生模块解包到 `<asar>.unpacked`。这类模块通常来自用户自己装的
 *     native 依赖（koffi / better-sqlite3 / node-pty），在共享宿主里加载会踩
 *     ABI 与进程级全局状态，确实该拒绝。
 *   - 纯目录布局（VS Code 系全家：Code / Cursor / Antigravity / Kiro）在
 *     `resources/app/node_modules/**` 里同样带 `.node`，但它们只被 workbench
 *     主进程按需加载，实测在 Electron 主版本匹配的宿主里工作正常
 *     （antigravity-ide 在宿主内成功加载 keymapping / spdlog / sqlite3 三个）。
 *     若把它们也算进来，整个 VS Code 系都会被拒绝——而它们正是主要目标。
 *
 * 主版本不匹配才是真正致命的（ABI 绑定），那一关由调用方单独校验。
 */
function hasNativeModules(appPath: string, binaryDir: string): boolean {
  const roots = [appPath + '.unpacked', path.join(binaryDir, 'resources', 'app.asar.unpacked')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (stack.length) {
      const { dir, depth } = stack.pop()!;
      if (depth > 6) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.node')) return true;
        if (e.isDirectory()) stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }
  }
  return false;
}

/** 找到真正携带 Chromium 版本的 Electron ELF。
 *
 * 很多打包方式的 desktop Exec 指向一个薄启动器（几十 KB），真正的 Electron
 * 二进制在同目录里。通用规则：优先用传入的路径；若它探测不到版本，就在同目录
 * （及子目录 resources 的兄弟位置）找最大的 ELF 再试。不为任何一个应用特判。 */
function resolveRealElectronBinary(binaryIn: string): string {
  let real = binaryIn;
  try {
    real = fs.realpathSync(binaryIn);
  } catch {
    /* 保留原路径 */
  }
  // 先看传入的二进制本身。注意 '0' 是「探测失败」的哨兵值，必须排除。
  const own = scanBinaryVersion(real);
  if (own !== '0' && /^(chrome-)?\d+$/.test(own)) return real;

  // 在同目录里找工作
  const dir = path.dirname(real);
  let best: { file: string; size: number } | null = null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return real;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    // Electron 主二进制通常 > 50MB；只考虑较大的可执行文件
    if (st.size < 50 * 1024 * 1024) continue;
    if (!(st.mode & 0o111)) continue;
    if (!best || st.size > best.size) best = { file: full, size: st.size };
  }
  return best ? best.file : real;
}

/**
 * 从任意二进制路径发现 Electron App。若不是 Electron App（无 app 载荷），返回 null。
 */
export function detectFromBinary(realBinaryIn: string): DetectedApp | null {
  // 探测**用户传入的路径**（可能是符号链接），同时兼顾可执行文件的真实位置。
  // 顺序很重要：符号链接本身所在目录才可能含 resources/app（例如
  // /tmp/fixture/electron -> /usr/lib/electron41/electron，只有前者有 resources）。
  const candidates: string[] = [];
  try {
    candidates.push(path.resolve(realBinaryIn));
  } catch {
    /* ignore */
  }
  try {
    const real = fs.realpathSync(realBinaryIn);
    if (!candidates.includes(real)) candidates.push(real);
  } catch {
    return null;
  }

  let realBinary = candidates[candidates.length - 1];
  let appPath: string | null = null;
  let binaryDir = '';
  for (const cand of candidates) {
    const dir = path.dirname(cand);
    const found = findAppPayload(dir);
    if (found) {
      appPath = found;
      binaryDir = dir;
      realBinary = cand;
      break;
    }
  }
  if (!appPath) return null;

  // package.json 是**可选增强**，不是识别的前提。
  // 原因：asar 内的文件可能是 Chromium 自定义编码（executable 文件）或特殊布局，
  // 我们绝不为某家 App 去特判解析方式。拿不到就用目录名，一样能通用识别和启动。
  const isAsar = appPath.endsWith('.asar');
  const pkg: Record<string, unknown> | null = isAsar
    ? readAsarPackageJson(appPath)
    : readDirPackageJson(appPath);

  const dirName = path.basename(path.dirname(path.join(appPath, 'x')));
  const fallbackName = sanitizeId(path.basename(binaryDir)) || 'app';
  const rawName = typeof pkg?.name === 'string' && pkg.name ? pkg.name : fallbackName;
  const displayName =
    (typeof pkg?.productName === 'string' && pkg.productName) ||
    (typeof pkg?.name === 'string' && pkg.name) ||
    path.basename(binaryDir);
  const main = typeof pkg?.main === 'string' ? pkg.main : undefined;
  // 版本探测必须对真实 Electron ELF 做。
  // 注意：有的应用 desktop 的 Exec 指向的是一个很薄的启动器（几十 KB），
  // 真正的 Electron 二进制是同一目录下那个 100MB+ 的文件。所以探测时，
  // 先试 target 本身，失败再在同目录里找「携带 Chromium 版本字符串的最大 ELF」。
  const probeBinary = resolveRealElectronBinary(realBinary);
  const major = detectElectronMajor(probeBinary);

  return {
    id: sanitizeId(rawName),
    realBinary,
    appPath,
    entry: main,
    major,
    hasNativeModules: hasNativeModules(appPath, binaryDir),
    displayName,
  };
}

/** 从 app 目录读 package.json（asar 之外的另一半世界）。失败返回 null。 */
function readDirPackageJson(appDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function sanitizeId(name: string): string {
  return name
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app';
}
