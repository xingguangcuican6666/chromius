/**
 * XDG 路径与运行期位置。所有路径集中在这里，避免散落。
 */
import * as os from 'os';
import * as path from 'path';

function envDir(name: string, fallback: string): string {
  return process.env[name] || path.join(os.homedir(), fallback);
}

/** ~/.config/chromius —— 持久状态（manifest、每 client 配置） */
export const CONFIG_DIR = path.join(envDir('XDG_CONFIG_HOME', '.config'), 'chromius');

/** ~/.local/share/chromius —— 安装的 shim 二进制、缓存的运行时 */
export const DATA_DIR = path.join(envDir('XDG_DATA_HOME', '.local/share'), 'chromius');

/** ~/.cache/chromius —— 可丢弃的缓存（版本探测结果等） */
export const CACHE_DIR = path.join(envDir('XDG_CACHE_HOME', '.cache'), 'chromius');

/** $XDG_RUNTIME_DIR/chromius —— socket，必须落在运行时目录（tmpfs） */
export function runtimeDir(): string {
  const base =
    process.env.XDG_RUNTIME_DIR ||
    path.join(os.tmpdir(), `chromius-${process.getuid?.() ?? 0}`);
  return path.join(base, 'chromius');
}

export function brokerSocketPath(): string {
  return path.join(runtimeDir(), 'broker.sock');
}

export const MANIFEST_PATH = path.join(CONFIG_DIR, 'manifest.json');
export const SHIM_BIN = path.join(DATA_DIR, 'bin', 'chromius-shim');
export const VERSION_CACHE = path.join(CACHE_DIR, 'electron-versions.json');
