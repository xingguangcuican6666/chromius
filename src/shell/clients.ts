/**
 * Chromius host —— 宿主主进程。
 *
 * 唯一长期运行的 Electron 进程，拥有唯一的 Browser / GPU / zygote / network 进程。
 * 每个「子应用」有两种模式：
 *   - web : 纯网页型（无 app.asar 主进程逻辑）。为它开一个 BrowserWindow，
 *           使用它专属的 session partition（= 独立 profile）。
 *   - vm  : 有主进程逻辑。在 vm 沙盒里运行其 main.js，注入虚拟 app + 作用域 ipcMain。
 *
 * 本文件不含任何 App 名相关的代码。
 */
import { app, BrowserWindow, ipcMain, session } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { ClientMode } from '../shared/spec';

export interface ClientSpec {
  id: string;
  displayName: string;
  mode: ClientMode;
  /** app.asar 或 app 目录 */
  appPath: string;
  /** 相对 appPath 的入口（vm 模式用） */
  entry?: string;
  realBinary: string;
  major: string;
  hasNativeModules: boolean;
  /** 原始启动参数（不含 argv[0]） */
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

interface Client {
  spec: ClientSpec;
  windows: BrowserWindow[];
  /** vm 模式的沙盒（web 模式为 null） */
  sandbox?: VmSandbox;
  /** 子应用请求退出时回调 */
  shutdown?: () => void;
}

interface VmSandbox {
  /** 虚拟 app 对象（Proxy 包裹真实 app） */
  virtualApp: Record<string, unknown>;
  /** 作用域化 ipcMain */
  scopedIpcMain: Record<string, unknown>;
  context: unknown;
}

const clients = new Map<string, Client>();

/** 每个子应用的 partition（= 磁盘上的独立 profile 目录） */
export function partitionFor(id: string): string {
  return `persist:chromius:${id}`;
}

/** 子应用专属的 userData 目录。沿用其原本的配置目录（已存在，无需迁移）。 */
export function userDataFor(spec: ClientSpec): string {
  // 从 app 名推导到 XDG_CONFIG_HOME 下的目录，若已存在则复用
  const configHome =
    spec.env['XDG_CONFIG_HOME'] ||
    path.join(spec.env['HOME'] || process.env.HOME || '', '.config');
  const candidate = path.join(configHome, spec.displayName);
  if (fs.existsSync(candidate)) return candidate;
  return path.join(configHome, spec.id);
}

export function createClient(spec: ClientSpec): Client {
  if (clients.has(spec.id)) return clients.get(spec.id)!;
  const client: Client = { spec, windows: [] };
  clients.set(spec.id, client);
  return client;
}

export function getClients(): Client[] {
  return [...clients.values()];
}

export function removeClient(id: string): void {
  const c = clients.get(id);
  if (!c) return;
  for (const w of c.windows) {
    if (!w.isDestroyed()) w.close();
  }
  clients.delete(id);
}

/** 创建一个 web 模式窗口 */
export function openWebWindow(client: Client, url: string): BrowserWindow {
  const { spec } = client;
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: spec.displayName,
    webPreferences: {
      partition: partitionFor(spec.id),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(url).catch((e) => {
    console.error(`[chromius] ${spec.id}: loadURL failed: ${e.message}`);
  });
  win.on('closed', () => {
    client.windows = client.windows.filter((w) => w !== win);
  });
  client.windows.push(win);
  return win;
}

/** 创建一个 vm 模式窗口（供子应用代码调用） */
export function createVmWindow(
  client: Client,
  opts: {
    url?: string;
    width?: number;
    height?: number;
    title?: string;
  },
): BrowserWindow {
  const { spec } = client;
  const win = new BrowserWindow({
    width: opts.width ?? 1024,
    height: opts.height ?? 768,
    title: opts.title ?? spec.displayName,
    webPreferences: {
      partition: partitionFor(spec.id),
      contextIsolation: true,
      sandbox: false, // 子应用可能自带 preload
      nodeIntegration: false,
    },
  });
  if (opts.url) win.loadURL(opts.url).catch(() => void 0);
  win.on('closed', () => {
    client.windows = client.windows.filter((w) => w !== win);
  });
  client.windows.push(win);
  return win;
}

export function ensureSessionPolicy(id: string): void {
  const ses = session.fromPartition(partitionFor(id));
  // 通用安全策略：默认拒绝敏感权限请求，子应用可后续覆盖
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}
