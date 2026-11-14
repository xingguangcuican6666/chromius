/**
 * shim → daemon → shell 之间传递的 JSON-lines 消息。
 * 一行一个 JSON 对象（NDJSON）。两端都不假定消息顺序，但按 request/response
 * 通过 id 关联。
 */

export type ClientMode = 'vm' | 'web';

/** 从文件系统探测出来的、与具体 App 无关的信息。 */
export interface DetectedApp {
  /** 稳定 id，默认取 app.asar 的 package.json name，否则目录名 */
  id: string;
  /** 真实二进制（符号链接被替换前的目标） */
  realBinary: string;
  /** app.asar 或 app 目录 */
  appPath: string;
  /** package.json 的 main 字段（相对 appPath），缺省表示 web 型 */
  entry?: string;
  /** Electron 主版本，如 "41" */
  major: string;
  /** 是否含原生 .node 模块（决定能否进共享宿主） */
  hasNativeModules: boolean;
  /** 检测到的显示名 */
  displayName: string;
}

/** shim 发起的启动请求 */
export interface LaunchRequest {
  kind: 'launch';
  id: string;
  detected: DetectedApp;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface StatusRequest {
  kind: 'status';
}

export interface KillRequest {
  kind: 'kill';
  id: string;
}

export interface OpenUrlRequest {
  kind: 'openUrl';
  id: string;
  url: string;
}

export type Request = LaunchRequest | StatusRequest | KillRequest | OpenUrlRequest;

export interface ClientInfo {
  id: string;
  mode: ClientMode;
  displayName: string;
  windowCount: number;
  /** 宿主进程 pid（信息性） */
  hostPid: number;
}

export interface ShellInfo {
  major: string;
  pid: number;
  clients: ClientInfo[];
}

export interface StatusResponse {
  ok: true;
  shells: ShellInfo[];
}

export interface LaunchResponse {
  ok: boolean;
  /** 宿主接管成功 */
  attached: boolean;
  /** 若 attached=false，原因（供 doctor 展示） */
  reason?: string;
  client?: ClientInfo;
}

export interface KillResponse {
  ok: boolean;
}

export interface ErrorResponse {
  ok: false;
  error: string;
}

export type Response = StatusResponse | LaunchResponse | KillResponse | ErrorResponse;

/** shim 用的最小探测结果（不依赖 daemon 运行） */
export interface ShimProbe {
  id: string;
  realBinary: string;
  appPath: string;
  entry?: string;
  major: string;
  hasNativeModules: boolean;
  displayName: string;
}
