/** 子应用规格 —— 各模块共享的唯一数据结构。 */

export type ClientMode = 'vm' | 'web';

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

/**
 * 决定一个已探测到的 App 该用哪种模式。完全通用，只依据结构特征：
 *   - 有 entry（package.json.main）且无原生模块 → vm 模式（能共享主进程）
 *   - 其它 → web 模式（只开窗口，共享内核基础设施）
 */
export function decideMode(entry: string | undefined, hasNative: boolean): ClientMode {
  if (entry && !hasNative) return 'vm';
  return 'web';
}
