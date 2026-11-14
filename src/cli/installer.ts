/**
 * 安装器 —— 把系统上的 Electron App 接入 Chromius。
 *
 * 机制（通用、无 per-app 代码）：
 *   1. 扫描用户级 + 系统级 .desktop，找到 Exec= 指向的绝对路径二进制
 *   2. 对每个二进制：detectFromBinary() 判断是否 Electron App
 *   3. 若是，把它替换成符号链接 → 我们的 shim，并把真实二进制路径记录进 manifest
 *   4. shim 通过 CHROMIUS_REAL_BIN 环境变量拿到真实路径 —— 但符号链接无法带 env。
 *
 * 因此实际做法：**不直接替换 App 二进制**（那会破坏 App 自身、需要 root），
 * 而是生成用户级 .desktop 覆盖，Exec 指向 `chromius launch <realBinary> %U`。
 * 这种方式：
 *   - 不需要 root
 *   - 不动 App 文件，App 自更新无影响
 *   - 覆盖 xdg 的应用菜单启动
 * 命令行直接调用二进制则不受影响（保留逃生通道，符合「金规」）。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectFromBinary } from '../shared/detect';
import { CONFIG_DIR, MANIFEST_PATH } from '../shared/paths';

export interface ManifestEntry {
  id: string;
  displayName: string;
  realBinary: string;
  major: string;
  mode: 'vm' | 'web';
  desktopFile: string;
  ownedDesktop: string; // 我们生成的用户级 .desktop
  hasNativeModules: boolean;
}

export interface Manifest {
  version: 1;
  cliPath: string;
  entries: ManifestEntry[];
}

export function loadManifest(): Manifest {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  } catch {
    return { version: 1, cliPath: '', entries: [] };
  }
}

export function saveManifest(m: Manifest): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

function listDesktopFiles(): string[] {
  const dirs = [
    path.join(os.homedir(), '.local', 'share', 'applications'),
    '/usr/local/share/applications',
    '/usr/share/applications',
  ];
  const out: string[] = [];
  for (const d of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(d);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (f.endsWith('.desktop')) out.push(path.join(d, f));
    }
  }
  return out;
}

interface DesktopInfo {
  file: string;
  exec: string; // 首个字段（可执行文件）
  args: string[]; // 其余参数（保留原始顺序，含 --disable-features 等）
  name?: string;
  /** 原始文件全文，用于生成保留全部元数据的覆盖版 */
  raw: string;
}

function parseDesktop(file: string): DesktopInfo | null {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  // 只看 [Desktop Entry] 段
  const section = content.split(/^\[/m).find((s) => s.startsWith('Desktop Entry]'));
  if (!section) return null;
  let execLine: string | undefined;
  let name: string | undefined;
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('Exec=')) execLine = line.slice(5);
    else if (line.startsWith('Name=') && !name) name = line.slice(5);
    else if (line.startsWith('Terminal=true')) return null; // 终端应用不接管
  }
  if (!execLine) return null;
  const parts = execLine.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const exec = parts[0];
  if (!path.isAbsolute(exec)) return null; // 只处理绝对路径
  // 保留除占位符之外的全部参数（这就是「按需挂载的特性」，不能丢）
  const args = parts.slice(1).filter((a) => !/^%[a-zA-Z]$/.test(a));
  return { file, exec, args, name, raw: content };
}

const USER_APPS = path.join(os.homedir(), '.local', 'share', 'applications');

/**
 * 覆盖版 desktop 的路径 = 用户级目录下**与原文件同名**的文件。
 *
 * 为什么用同名而不是 `chromius-<id>.desktop`：xdg 规范里 ~/.local/share/applications
 * 优先于 /usr/share/applications，且**按文件名（desktop id）去重**。用同名文件，
 * 原条目就被替换而不是并列显示——菜单里只留一个。
 */
function ownedDesktopPath(originalFile: string): string {
  return path.join(USER_APPS, path.basename(originalFile));
}

/** 生成覆盖版 desktop：保留原文件所有元数据，只把 Exec 改成经 chromius 启动。 */
function writeOwnedDesktop(
  entry: ManifestEntry,
  original: DesktopInfo,
  cliPath: string,
  nodePath: string,
): void {
  fs.mkdirSync(USER_APPS, { recursive: true });
  // nodePath 为空表示 cliPath 本身可执行（已安装的 /usr/bin/chromius）
  const prefix = nodePath ? `${nodePath} ${cliPath}` : cliPath;
  const execLine = `${prefix} launch ${entry.realBinary} ${original.args.join(' ')} %U`
    .replace(/\s+/g, ' ')
    .trim();

  let content = original.raw;
  if (/^Exec=.*$/m.test(content)) {
    content = content.replace(/^Exec=.*$/m, `Exec=${execLine}`);
  } else {
    content += `\nExec=${execLine}\n`;
  }
  // 标记来源（便于 doctor/uninstall 识别），若已有则替换
  if (/^X-Chromius-Managed=.*$/m.test(content)) {
    content = content.replace(/^X-Chromius-Managed=.*$/m, 'X-Chromius-Managed=true');
  } else {
    content = content.replace(/^\[Desktop Entry\]\s*$/m, `[Desktop Entry]\nX-Chromius-Managed=true`);
  }
  if (/^X-Chromius-Original=.*$/m.test(content)) {
    content = content.replace(/^X-Chromius-Original=.*$/m, `X-Chromius-Original=${original.file}`);
  } else {
    content = content.replace(/^X-Chromius-Managed=true\s*$/m, `X-Chromius-Managed=true\nX-Chromius-Original=${original.file}`);
  }

  const target = ownedDesktopPath(original.file);
  fs.writeFileSync(target, content);
  entry.ownedDesktop = target;
}

/** desktop 条目的优先级：数值越小越优先。主条目要优先于 url-handler 之类的附属条目。 */
function desktopRank(file: string): number {
  const base = path.basename(file);
  if (/-url-handler\.desktop$/i.test(base)) return 3;
  if (/\.desktop$/i.test(base)) return 1;
  return 2;
}

export function install(cliPath: string, nodePath: string): { installed: number; skipped: number } {
  const manifest = loadManifest();
  manifest.cliPath = cliPath;
  let installed = 0;

  // 清理上一版本遗留的 chromius-<id>.desktop（新方案用同名覆盖，不再需要它们）
  for (const e of manifest.entries) {
    if (/chromius-/.test(path.basename(e.ownedDesktop))) {
      try {
        fs.unlinkSync(e.ownedDesktop);
      } catch {
        /* ignore */
      }
      e.ownedDesktop = '';
    }
  }

  // 按优先级排序：同一个二进制的多个 desktop 条目里，主条目先被看到。
  const files = listDesktopFiles().sort((a, b) => desktopRank(a) - desktopRank(b));

  const seen = new Set<string>();
  for (const file of files) {
    const info = parseDesktop(file);
    if (!info) continue;
    if (seen.has(info.exec)) continue;

    const detected = detectFromBinary(info.exec);
    if (!detected) continue;
    seen.add(info.exec);

    const existing = manifest.entries.find((e) => e.realBinary === detected.realBinary);
    if (existing) {
      writeOwnedDesktop(existing, info, cliPath, nodePath);
      continue;
    }

    const entry: ManifestEntry = {
      id: detected.id,
      displayName: detected.displayName || info.name || detected.id,
      realBinary: detected.realBinary,
      major: detected.major,
      mode: detected.entry && !detected.hasNativeModules ? 'vm' : 'web',
      desktopFile: file,
      ownedDesktop: '',
      hasNativeModules: detected.hasNativeModules,
    };
    writeOwnedDesktop(entry, info, cliPath, nodePath);
    manifest.entries.push(entry);
    installed++;
  }

  saveManifest(manifest);
  const skipped = seen.size - installed;
  return { installed, skipped };
}

export function uninstall(): { removed: number } {
  const manifest = loadManifest();
  let removed = 0;
  const drop = (p: string) => {
    try {
      // 只删除我们自己生成的（带 Chromius 标记）
      if (!fs.existsSync(p)) return;
      if (!/X-Chromius-Managed=true/.test(fs.readFileSync(p, 'utf8'))) return;
      fs.unlinkSync(p);
      removed++;
    } catch {
      /* ignore */
    }
  };
  for (const e of manifest.entries) {
    if (e.ownedDesktop) drop(e.ownedDesktop);
  }
  // 旧版 chromius-*.desktop 可能残留（不在 manifest，或 manifest 已乱）
  try {
    for (const f of fs.readdirSync(USER_APPS)) {
      if (/^chromius-.*\.desktop$/.test(f)) drop(path.join(USER_APPS, f));
    }
  } catch {
    /* ignore */
  }
  manifest.entries = [];
  saveManifest(manifest);
  return { removed };
}

/** 对一个二进制执行探测（供 doctor / launch 使用）。 */
export function probe(realBinary: string) {
  return detectFromBinary(realBinary);
}
