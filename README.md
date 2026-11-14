# Chromius

把系统里多个 Electron 应用收进**一个共享的 Chromium 宿主**，消除重复的浏览器基础设施（Browser / GPU / zygote / Network / audio 进程），同时让每个应用保留独立的存储、JS 上下文和 `app` 视图。

## 它能解决什么

每个 Electron 应用都自带一整套 Chromium 栈。装 5 个 Electron 应用，就有 5 份 GPU 进程、5 份网络服务、5 套 zygote —— 这些都是纯开销。Chromius 让它们**共用一套**。

本机实测（PSS，共享页按比例折算后的真实占用）：

| 形态 | 进程数 | 总 PSS |
|---|---|---|
| 1 个应用独立运行 | 6 | 274 MB |
| **1 个共享宿主 + 1 个子应用** | 8 | **224 MB** |
| **1 个共享宿主 + 2 个子应用** | 9 | **232 MB**（第二个只多 8 MB） |
| 3 个应用各自独立 | 18 | 486 MB |

关键：**每多接一个子应用，只增加一个渲染器（约几十 MB），不再重复整套基础设施。**

## 不能做什么（诚实说明）

- **运行时版本必须匹配**：应用是哪个 Electron 大版本，就需要那个版本的宿主（原生模块 ABI 与 V8 绑定）。没有对应运行时就回退独立运行。
- **asar 应用自带解包原生模块时不接管**：`<app>.asar.unpacked/` 里的 `.node` 通常来自用户自己装的 native 依赖，有进程级全局状态，共享宿主不安全。纯目录布局（VS Code 系：Code / Cursor / Kiro / Antigravity）不在此列——它们的 `.node` 只被主进程按需加载，实测在版本匹配的宿主里工作正常。
- **不接管 Edge / Steam**：它们不是 Electron 应用（不读 `app.asar`），不在管辖范围。

## 工作原理

```
 .desktop (用户级覆盖，保留全部元数据)
      │  Exec=node chromius launch <真实二进制> <原始参数…>
      ▼
   chromius launch ──探测结构──► 是 Electron 应用?
      │                           │
      │ 否 / 原生模块 / 无运行时     │ 是
      ▼                           ▼
  exec 真实二进制            chromiusd (unix socket)
  （行为与今日完全一致）           │
                                 ▼
                          共享宿主 electron<major>
                          ├── 唯一 Browser 进程
                          ├── 唯一 GPU 进程
                          ├── 唯一 Network / audio / zygote
                          ├── 子应用 A ─ vm 沙盒（跑其 main.js）
                          └── 子应用 B ─ 渲染器窗口
```

### 两种接入模式（自动选择，无逐应用代码）

- **vm 模式**：有 `package.json.main` 的应用。在宿主内运行它的主进程逻辑，注入**虚拟 `app`**（隔离的 `userData`/名称/单实例锁）、**作用域 `ipcMain`** 和**作用域 `utilityProcess`**。VS Code 系的 `vscode-file://` / `vscode-webview://` 由宿主在 ready 前预注册为 privileged scheme，否则 CSP 的 `'self'` 会拒绝全部资源（白屏）。
- **web 模式**：其余情况。为它开一个窗口，使用独立 `session` partition（磁盘上独立的 profile 目录）。

vm 模式的通道名**不加前缀**：子应用的主进程和它自己的渲染器是同一套代码、用同一批 `vscode:xxx` 通道名，加前缀会让两边对不上。

### 生命周期

`kill` 一个子应用会撤销它留下的一切，使同一宿主里可以反复 `launch`：

- 它注册的 `ipcMain` handler / 监听器、`app` 监听器、`session.protocol` handler
- 它 fork 的 `utilityProcess`（extension host / pty host / shared process）——这些进程不随窗口关闭而结束，不回收会让内存越堆越高
- 它自己 listen 的 unix socket（VS Code 系用它做单实例检测，残留会让下次启动误判「已有实例」并自杀）
- 原生插件垫片里属于它的订阅

**原生插件垫片**：`native-keymap` 的 `onDidChangeKeyboardLayout()` 每次调用都会 `napi_add_env_cleanup_hook`，而 Node 对同一 `(env, fun)` 注册两次是 **abort，不是可捕获异常**。宿主接管该模块的加载，让原生侧全进程只注册一次、JS 侧自己分发订阅。见 `src/shell/addon-shims.ts`。

### 隔离能力

| 能隔离（每应用独立） | 不能隔离（进程级单例） |
|---|---|
| cookie / localStorage / IndexedDB / 缓存 | 进程级开关（`--disable-gpu` 等）→ 需专用宿主 |
| service worker / storage | 子应用之间同名的 `ipcMain` 通道会互相覆盖 |
| session partition（独立 profile 目录） | — |
| `app.getPath('userData')` / 名称 / 单实例锁 / `ipcMain` | — |
| `utilityProcess` 的回收 | — |

## 安装

### 从 AUR

```bash
yay -S chromius          # 或 paru -S chromius
```

包只装 `chromius` 本身；共享宿主用的是系统里的 `electron<major>`（按需安装，
见下方 `init-runtime`）。运行时零 npm 依赖。

### 从源码

```bash
npm install
npm run build          # 编译 TS + shim

node out/cli/index.js doctor          # 看本机各应用能否接入
node out/cli/index.js install         # 生成用户级 .desktop 接管（无需 root）
node out/cli/index.js uninstall       # 撤销接管
```

`install` **不改任何应用文件**，只在 `~/.local/share/applications/` 生成接管版 `.desktop`，完整保留原 Name/Icon/Categories/MimeType 和全部启动参数，只把 `Exec` 改为经 Chromius 启动。应用自身的自动更新不会破坏它。

### 守护进程（可选，让首次启动更快）

```bash
chromius daemon
# 或交给 systemd --user：
systemctl --user enable --now chromiusd
```

`launch` 在 daemon 未运行时也会自动拉起它。

### 补齐缺失的运行时

```bash
chromius init-runtime 44    # 提示如何安装 electron44
```

## 命令

| 命令 | 作用 |
|---|---|
| `doctor` | 报告每个应用能否接入、不能的原因、需要的运行时 |
| `install` / `uninstall` | 生成 / 移除 `.desktop` 接管 |
| `launch <bin> [args…]` | 经 Chromius 启动一个应用 |
| `status` | 查看运行中的宿主与子应用 |
| `daemon` | 前台运行守护进程 |
| `init-runtime <major>` | 检查/安装某个 Electron 运行时 |

## 兜底原则

**任何环节失败都回退到独立运行**：探测失败、原生模块、运行时缺失、宿主报错、加载超时 —— 一律 `exec` 真实二进制，行为与直接运行完全一致。不会因为 Chromius 让应用打不开。

## 测试

```bash
npm run build
bash test/e2e.sh            # 端到端：唯一宿主 + 边际成本
./test/measure-pss.sh <pid> # 测量某进程树的真实 PSS
```

## 目录

```
src/
  shared/   探测算法（结构识别，零逐应用代码）、路径、协议、类型、预注册 scheme
  shell/    宿主：clients、vm 沙盒、虚拟 app、原生插件垫片、socket 服务、入口
  daemon/   按运行时版本管理宿主生命周期
  cli/      install / launch / status / doctor / init-runtime；installer
  shim/     C 实现的启动拦截器（备用透明路径）
packaging/aur/   PKGBUILD；推 v* tag 后 CI 自动构建、发 Release、推 AUR
```

## 调试

设 `CHROMIUS_DEBUG=1` 打开宿主诊断：渲染器 console、`did-finish-load` 后的 DOM 探针、挂起 Promise 的创建栈。不设时只保留 `did-fail-load` / `render-process-gone` 这类必报错误。

## 发布

推一个 `v*` tag 即触发 `.github/workflows/build.yml`：在 Arch 容器里
`makepkg` 构建、生成 `.SRCINFO`、把 PKGBUILD 推到 AUR 仓库、把
`.pkg.tar.zst` 附到 GitHub Release。手动触发（`workflow_dispatch`）只构建不发布，
用于打 tag 前先验证。
