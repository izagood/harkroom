import { createServer, type Server } from 'node:http';
import type { AvcsLogEntry } from '../../src/avcs/client.js';

export async function startFakeAvcs(): Promise<{
  url: string;
  push(repo: string, e: Omit<AvcsLogEntry, 'logIndex'>): void;
  close(): Promise<void>;
}> {
  const logs = new Map<string, AvcsLogEntry[]>();
  const waiters = new Set<() => void>();

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const [, repo, endpoint] = url.pathname.split('/');
    const log = logs.get(repo ?? '') ?? [];
    const since = Number(url.searchParams.get('since') ?? '0');

    if (endpoint === 'sync') {
      const entries = log.filter((e) => e.logIndex > since);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ version: 1, next: log.length, entries }));
      return;
    }
    if (endpoint === 'events') {
      const timeoutMs = Math.min(Number(url.searchParams.get('timeoutMs') ?? '30000'), 60_000);
      const answer = () => { res.statusCode = 200; res.end(JSON.stringify({ changed: true })); };
      if (log.length > since) { answer(); return; }
      const timer = setTimeout(() => { waiters.delete(wake); res.statusCode = 204; res.end(); }, timeoutMs);
      const wake = () => {
        const current = logs.get(repo ?? '') ?? [];
        if (current.length > since) { clearTimeout(timer); waiters.delete(wake); answer(); }
      };
      waiters.add(wake);
      req.on('close', () => { clearTimeout(timer); waiters.delete(wake); });
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const url = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  return {
    url,
    push(repo, e) {
      const log = logs.get(repo) ?? [];
      log.push({ ...e, logIndex: log.length + 1 });
      logs.set(repo, log);
      for (const w of [...waiters]) w();
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
