/**
 * 宿主在 app ready 之前预注册的 privileged scheme 清单。
 *
 * `protocol.registerSchemesAsPrivileged` 只能在 ready 前调用（ready 后直接抛错），
 * 而子应用的入口代码在宿主 ready 之后才求值，来不及自己注册。缺了这些标记，
 * scheme 就不是「standard」，会连锁引发两类故障：
 *
 *   1. 页面 origin 变成 "null"，页面自身 CSP 的 `'self'` 认不出同源资源，
 *      workbench.js / *.css 全被拒绝 → 白屏，body 里只剩一个空 <body>；
 *   2. Chromium 的 URL 解析器不认该 scheme 的 host 段，Electron 的 webRequest
 *      url 过滤器解析 `vscode-file://*` 时报 "Wrong scheme type" → 子应用在
 *      建第一个窗口时直接抛错退出。
 *
 * 所以由宿主代劳。虚拟 protocol 会把子应用的重复注册吞掉（见 virtual-app.ts），
 * 遇到不在本清单里的 scheme 会打警告——那时把 scheme 加到这里即可。
 */
export interface PrivilegedScheme {
  scheme: string;
  privileges: Record<string, boolean>;
}

/** VS Code 系（Code / Cursor / Antigravity / Kiro …）用的两个 scheme。 */
export const PRIVILEGED_SCHEMES: PrivilegedScheme[] = [
  {
    scheme: 'vscode-file',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true },
  },
  {
    scheme: 'vscode-webview',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      allowServiceWorkers: true,
      codeCache: true,
    },
  },
];

export const PRE_REGISTERED_SCHEMES: ReadonlySet<string> = new Set(
  PRIVILEGED_SCHEMES.map((s) => s.scheme),
);
