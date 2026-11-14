#!/usr/bin/env node
/**
 * Chromius CLI。
 *
 *   chromius install             生成用户级 .desktop 接管，无需 root
 *   chromius uninstall           移除接管
 *   chromius launch <bin> [args] 通过 Chromius 启动（.desktop 用的就是这个）
 *   chromius status              列出正在运行的宿主与子应用
 *   chromius doctor              报告本机各 Electron App 能否接入及原因
 *   chromius daemon              前台运行守护进程
 *
 * launch 的行为（金规）：能接入就接入；任一环节失败，就 exec 真实二进制，
 * 表现与直接运行完全一致。
 */
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { brokerSocketPath, runtimeDir } from '../shared/paths';
import { detectFromBinary } from '../shared/detect';
import { decideMode } from '../shared/spec';
import { install, uninstall, loadManifest, probe } from './installer';

const SHIM_SRC = path.join(__dirname, '..', 'chromius-shim');

async function cmd(args: string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case 'install':
      return cmdInstall();
    case 'uninstall': {
      const r = uninstall();
      console.log(`removed ${r.removed} desktop entries`);
      return 0;
    }
    case 'launch':
      return cmdLaunch(args.slice(1));
    case 'status':
      return cmdStatus();
    case 'doctor':
      return cmdDoctor();
    case 'daemon':
      return cmdDaemon();
    case 'init-runtime':
      return cmdInitRuntime(args.slice(1));    default:
      printHelp();
      return sub ? 1 : 0;
  }
}

function printHelp(): void {
  console.log(`chromius <command>

  install                   接管本机的 Electron App（无需 root）
  uninstall                 移除接管
  launch <bin> [args...]    经 Chromius 启动一个 App
  status                    查看运行中的宿主与子应用
  doctor                    报告各 App 能否接入及原因
  daemon                    前台运行守护进程（通常交给 systemd --user）
  init-runtime <major>      检查/安装某个 Electron 主版本的运行时
`);
}

function cmdInstall(): number {
  // 已安装（Arch 包）→ .desktop 直接用 /usr/bin/chromius，不依赖 node 路径。
  // 从源码目录运行时 → 用 node + 当前脚本的绝对路径。
  const installedEntry = '/usr/bin/chromius';
  let cliPath: string;
  let nodePath: string;
  if (fs.existsSync(installedEntry)) {
    cliPath = installedEntry;
    nodePath = '';
  } else {
    cliPath = path.resolve(__filename);
    nodePath = process.execPath;
  }
  const r = install(cliPath, nodePath);
  console.log(`installed ${r.installed} app(s), skipped ${r.skipped}`);
  console.log(`manifest: ~/.config/chromius/manifest.json`);
  return 0;
}

/** 与 daemon 通信；daemon 不在就返回 null */
function rpcOnce(msg: Record<string, unknown>, timeoutMs = 25000): Promise<Record<string, unknown> | null> {
  const sock = brokerSocketPath();
  return new Promise((resolve) => {
    const s = net.createConnection(sock);
    let buf = '';
    let done = false;
    const finish = (v: Record<string, unknown> | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    s.setEncoding('utf8');
    s.on('connect', () => s.write(JSON.stringify(msg) + '\n'));
    s.on('data', (c: string) => {
      buf += c;
      const i = buf.indexOf('\n');
      if (i >= 0) {
        try {
          finish(JSON.parse(buf.slice(0, i)));
        } catch {
          finish(null);
        }
      }
    });
    s.on('error', () => finish(null));
  });
}

function ensureDaemon(): boolean {
  // 已有 daemon？
  if (fs.existsSync(brokerSocketPath())) return true;
  fs.mkdirSync(runtimeDir(), { recursive: true });
  const logPath = path.join(runtimeDir(), 'daemon.log');
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon', 'main.js')], {
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  // 等 socket 出现
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (fs.existsSync(brokerSocketPath())) return true;
    spawnSync('sleep', ['0.05']);
  }
  return fs.existsSync(brokerSocketPath());
}

function cmdLaunch(args: string[]): number | Promise<number> {
  const realBinary = args[0];
  if (!realBinary) {
    console.error('usage: chromius launch <bin> [args...]');
    return 2;
  }
  const appArgs = args.slice(1);
  const detected = detectFromBinary(realBinary);
  if (!detected) return execReal(realBinary, appArgs);

  // 原生模块 / 未知版本直接透传（不折腾）
  if (detected.hasNativeModules || !detected.major || detected.major === '0') {
    return execReal(realBinary, appArgs);
  }

  if (!ensureDaemon()) return execReal(realBinary, appArgs);

  const env: Record<string, string> = {};
  for (const k of ['WAYLAND_DISPLAY', 'DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'HOME', 'USER', 'LANG', 'TZ']) {
    if (process.env[k]) env[k] = process.env[k] as string;
  }

  return rpcOnce({
    kind: 'launch',
    realBinary: detected.realBinary,
    argv: appArgs,
    cwd: process.cwd(),
    env,
  }).then((r) => {
    if (r && r['attached'] === true) {
      const mode = decideMode(detected.entry, detected.hasNativeModules);
      console.log(`[chromius] attached ${detected.id} (${mode})`);
      return 0;
    }
    const why = r ? String(r['reason'] || 'unknown') : 'daemon unavailable';
    console.error(`[chromius] standalone ${detected.id}: ${why}`);
    return execReal(realBinary, appArgs);
  });
}

/** 金规回退：以完全相同的方式运行真实二进制。 */
function execReal(realBinary: string, args: string[]): number {
  const r = spawnSync(realBinary, args, {
    stdio: 'inherit',
    env: { ...process.env, CHROMIUS_SHIM_ACTIVE: '1' },
  });
  if (r.error) {
    console.error(`cannot run ${realBinary}: ${r.error.message}`);
    return 127;
  }
  return r.status ?? 0;
}

function cmdStatus(): Promise<number> {
  return rpcOnce({ kind: 'status' }, 5000).then((r) => {
    if (!r) {
      console.log('chromiusd not running');
      return 0;
    }
    console.log(JSON.stringify(r, null, 2));
    return 0;
  });
}

function listAvailableMajors(): Set<string> {
  // 与 daemon 的扫描逻辑保持一致：<lib>/electron<major>/electron
  const majors = new Set<string>();
  for (const d of ['/usr/lib', '/usr/local/lib', '/opt']) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const m = e.isDirectory() && e.name.match(/^electron(\d+)$/);
      if (m && fs.existsSync(path.join(d, e.name, 'electron'))) majors.add(m[1]);
    }
  }
  return majors;
}

function cmdDoctor(): number {
  const manifest = loadManifest();
  const available = listAvailableMajors();
  console.log(`available runtimes: ${[...available].sort().map((m) => 'electron' + m).join(', ') || '(none)'}`);
  console.log();
  if (manifest.entries.length === 0) {
    console.log('no managed apps. run: chromius install');
  }
  for (const e of manifest.entries) {
    const d = probe(e.realBinary);
    let verdict: string;
    if (!d) verdict = 'standalone — no longer an electron app';
    else if (d.hasNativeModules) verdict = 'standalone — bundles native .node modules';
    else if (!d.major || d.major === '0') verdict = 'standalone — unknown runtime major';
    else if (!available.has(d.major))
      verdict = `standalone — no electron${d.major} runtime installed (run: chromius init-runtime ${d.major})`;
    else {
      const mode = decideMode(d.entry, d.hasNativeModules);
      verdict = `attachable — shared electron${d.major} host (${mode} mode)`;
    }
    console.log(`${e.displayName.padEnd(24)} ${verdict}`);
    console.log(`  binary:  ${e.realBinary}`);
    console.log(`  runtime: electron${d?.major ?? '?'}  payload: ${d?.appPath ?? '?'}`);
  }
  void SHIM_SRC;
  return 0;
}

function cmdDaemon(): number {
  require('../daemon/main');
  return 0;
}

/**
 * 确保某个 Electron 主版本的运行时存在。
 * 我们不自己下载 Electron（安全 + 体积），而是检测系统包管理器是否有该版本并给出命令。
 * 检出后宿主自动可用 —— daemon 扫描 /usr/lib/electron<major>。
 */
function cmdInitRuntime(args: string[]): number {
  const major = String(args[0] || '').replace(/^electron/, '');
  if (!major || !/^\d+$/.test(major)) {
    console.error('usage: chromius init-runtime <major>   e.g. chromius init-runtime 44');
    return 2;
  }
  const available = listAvailableMajors();
  if (available.has(major)) {
    console.log(`electron${major} already installed at /usr/lib/electron${major}`);
    return 0;
  }
  // 探测 pacman 官方源
  let inRepo = false;
  try {
    const r = spawnSync('pacman', ['-Ss', `^electron${major}$`], { encoding: 'utf8' });
    inRepo = (r.stdout || '').includes(`/electron${major} `);
  } catch {
    /* 无 pacman */
  }
  if (inRepo) {
    console.log(`electron${major} is available in the Arch repos. Install it with:`);
    console.log(`    sudo pacman -S electron${major}`);
    return 0;
  }
  console.log(`electron${major} is not in the Arch repos (current repos stop at electron44).`);
  console.log('Options:');
  console.log(`  • AUR:      yay -S electron${major}-bin   (if an AUR package exists)`);
  console.log(`  • manual:   download Electron ${major}.x from https://github.com/electron/electron/releases`);
  console.log(`              and unpack so that /usr/lib/electron${major}/electron exists.`);
  console.log('Apps needing this runtime will keep running standalone until then.');
  return 1;
}

void cmd(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
