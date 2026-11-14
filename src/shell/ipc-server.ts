/**
 * 宿主内的 unix socket 服务。daemon 把 attach 请求转发到这里。
 * NDJSON：一行一个 JSON。
 */
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

export type Handler = (msg: Record<string, unknown>) => Promise<Record<string, unknown>>;

export function startSocketServer(sockPath: string, handler: Handler): Promise<net.Server> {
  try {
    fs.unlinkSync(sockPath);
  } catch {
    /* 不存在 */
  }
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });

  const server = net.createServer((socket) => {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        void handleLine(line, socket);
      }
    });
    let closed = false;
    const handleLine = async (line: string, s: net.Socket) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        s.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n');
        return;
      }
      try {
        const resp = await handler(msg);
        s.write(JSON.stringify(resp) + '\n');
      } catch (e) {
        s.write(
          JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) + '\n',
        );
      }
      if (!closed) {
        // 单请求单连接：回复后关闭
        try {
          s.end();
        } catch {
          /* ignore */
        }
      }
    };
    socket.on('close', () => {
      closed = true;
    });
    socket.on('error', () => {
      closed = true;
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => {
      try {
        fs.chmodSync(sockPath, 0o600);
      } catch {
        /* ignore */
      }
      resolve(server);
    });
  });
}
