/**
 * chromiusd —— 守护进程。
 *
 * 职责：
 *  - 监听 broker.sock，接收 shim 的 launch 请求
 *  - 按 Electron 主版本管理宿主进程（每个版本一个 host）
 *  - 把请求转发给对应宿主，把结果回给 shim
 *
 * 本文件不含任何 App 名相关的代码。
 */
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { brokerSocketPath, runtimeDir } from '../shared/paths';
import { detectFromBinary } from '../shared/detect';

const HOST_SCRIPT = path.join(__dirname, '..', 'shell', 'main.js');

/** major → 宿主进程与其 socket */
interface Host {
  major: string;
  electronBinary: string;
  proc: ChildProcess;
  socket: string;
  clients: number;
}
const hosts = new Map<string, Host>();

/** 找出本机的 electron 二进制及其主版本。候选来自常见安装位置与 PATH。 */
function findElectronBinaries(): Array<{ binary: string; major: string }> {
  const result: Array<{ binary: string; major: string }> = [];
  const dirs = ['/usr/lib', '/usr/local/lib', '/opt'];
  for (const d of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const m = e.name.match(/^electron(\d+)$/);
      if (!m) continue;
      const bin = path.join(d, e.name, 'electron');
      if (fs.existsSync(bin)) result.push({ binary: bin, major: m[1] });
    }
  }
  return result;
}

function hostSocketFor(major: string): string {
  return path.join(runtimeDir(), `host-${major}.sock`);
}

/** 确保某个主版本的宿主在运行；返回其 socket 路径 */
async function ensureHost(major: string): Promise<Host | null> {
  const existing = hosts.get(major);
  if (existing && existing.proc.exitCode === null) return existing;

  const binaries = findElectronBinaries();
  const match = binaries.find((b) => b.major === major);
  if (!match) return null;

  const socket = hostSocketFor(major);
  try {
    fs.unlinkSync(socket);
  } catch {
    /* ignore */
  }

  const proc = spawn(match.binary, [HOST_SCRIPT, `--chromius-host=${major}`, `--socket=${socket}`], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: false,
    env: { ...process.env },
  });

  const host: Host = { major, electronBinary: match.binary, proc, socket, clients: 0 };
  hosts.set(major, host);

  // 等宿主 socket 就绪（最多 10 秒）
  const ok = await waitForSocket(socket, 10000);
  if (!ok) {
    console.error(`[chromiusd] host ${major} failed to start`);
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    hosts.delete(major);
    return null;
  }

  proc.on('exit', (code) => {
    console.log(`[chromiusd] host ${major} exited (${code})`);
    hosts.delete(major);
    try {
      fs.unlinkSync(socket);
    } catch {
      /* ignore */
    }
  });

  console.log(`[chromiusd] host ${major} ready pid=${proc.pid}`);
  return host;
}

function waitForSocket(sock: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (fs.existsSync(sock)) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** 向某个 socket 发送一条 NDJSON 请求并等待一条回复 */
function rpc(sock: string, msg: Record<string, unknown>, timeoutMs = 20000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sock);
    let buf = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      s.destroy();
      reject(new Error('rpc timeout'));
    }, timeoutMs);
    s.setEncoding('utf8');
    s.on('connect', () => s.write(JSON.stringify(msg) + '\n'));
    s.on('data', (chunk: string) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        s.end();
        try {
          resolve(JSON.parse(buf.slice(0, idx)));
        } catch (e) {
          reject(e);
        }
      }
    });
    s.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** 处理一条来自 shim 的 launch 请求 */
async function handleLaunch(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  const realBinary = String(msg['realBinary'] || '');
  const detected = detectFromBinary(realBinary);
  if (!detected) return { ok: true, attached: false, reason: 'not an electron app' };
  if (detected.hasNativeModules)
    return { ok: true, attached: false, reason: 'native .node modules' };
  if (!detected.major || detected.major === '0')
    return { ok: true, attached: false, reason: 'unknown runtime major' };

  const host = await ensureHost(detected.major);
  if (!host) return { ok: true, attached: false, reason: `no runtime for major ${detected.major}` };

  try {
    const resp = await rpc(host.socket, msg);
    if (resp['attached'] === true) host.clients++;
    return resp;
  } catch (e) {
    return {
      ok: true,
      attached: false,
      reason: `host rpc failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function startBroker(): void {
  const sock = brokerSocketPath();
  try {
    fs.unlinkSync(sock);
  } catch {
    /* ignore */
  }
  fs.mkdirSync(path.dirname(sock), { recursive: true });

  const server = net.createServer((socket) => {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        socket.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n');
        socket.end();
        return;
      }
      handleAny(msg)
        .then((resp) => {
          socket.write(JSON.stringify(resp) + '\n');
          socket.end();
        })
        .catch((e) => {
          socket.write(JSON.stringify({ ok: false, error: String(e) }) + '\n');
          socket.end();
        });
    });
    socket.on('error', () => void 0);
  });

  server.listen(sock, () => {
    try {
      fs.chmodSync(sock, 0o600);
    } catch {
      /* ignore */
    }
    console.log(`[chromiusd] listening on ${sock}`);
  });

  const cleanup = () => {
    try {
      fs.unlinkSync(sock);
    } catch {
      /* ignore */
    }
    for (const h of hosts.values()) {
      try {
        h.proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

async function handleAny(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  const kind = msg['kind'] as string;
  if (kind === 'launch') return handleLaunch(msg);
  if (kind === 'status') {
    const shells = [];
    for (const h of hosts.values()) {
      let clients: unknown[] = [];
      try {
        const r = await rpc(h.socket, { kind: 'status' }, 3000);
        if (Array.isArray(r['clients'])) clients = r['clients'] as unknown[];
      } catch {
        /* host 无响应 */
      }
      shells.push({ major: h.major, pid: h.proc.pid || 0, clients });
    }
    return { ok: true, shells };
  }
  if (kind === 'ping') return { ok: true, pong: true };
  return { ok: false, error: `unknown kind: ${kind}` };
}

startBroker();
