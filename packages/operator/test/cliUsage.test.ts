import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import {
  claudeCliUsage,
  codexCliUsage,
  parseClaudeReset,
  parseClaudeUsageText,
  parseCodexRateLimits,
  type RpcChild,
} from '../src/cliUsage.js';
import { cliThenApi, createUsageCache } from '../src/usageChain.js';

// claude 2.1.283 `claude -p /usage` 실측 출력(개인 값 없음 — 숫자·시각만).
const CLAUDE_OUT = `You are currently using your subscription to power your Claude Code usage

Current session: 36% used · resets Sep 29 at 5:29am (Asia/Seoul)
Current week (all models): 21% used · resets Sep 30 at 6:59pm (Asia/Seoul)
Current week (Fable): 0% used · resets Sep 30 at 7pm (Asia/Seoul)

What's contributing to your limits usage?
Last 24h · 2900 requests · 52 sessions
  76% of your usage was at >150k context
`;
const NOW = Date.parse('2026-09-28T17:45:00Z');

describe('claude /usage 파싱', () => {
  it('세션·주간·모델별 주간을 읽고 시간대를 반영해 복귀 시각을 낸다', () => {
    const r = parseClaudeUsageText(CLAUDE_OUT, NOW)!;
    expect(r.session).toEqual({ usedPercent: 36, resetsAtMs: Date.parse('2026-09-28T20:29:00Z') });
    expect(r.weekly).toEqual({ usedPercent: 21, resetsAtMs: Date.parse('2026-09-30T09:59:00Z') });
    expect(r.extra).toEqual([{ label: 'Fable weekly', window: { usedPercent: 0, resetsAtMs: Date.parse('2026-09-30T10:00:00Z') } }]);
  });

  it('날짜 없는 시각은 오늘, 이미 지났으면 내일이다 · 연말엔 해를 넘긴다', () => {
    expect(parseClaudeReset('7pm (UTC)', NOW)).toBe(Date.parse('2026-09-28T19:00:00Z'));
    expect(parseClaudeReset('5pm (UTC)', NOW)).toBe(Date.parse('2026-09-29T17:00:00Z'));
    expect(parseClaudeReset('Jan 2 at 9am (UTC)', Date.parse('2026-12-30T00:00:00Z'))).toBe(Date.parse('2027-01-02T09:00:00Z'));
    expect(parseClaudeReset('whenever', NOW)).toBeNull();
    expect(parseClaudeReset('7pm (Not/AZone)', NOW)).toBeNull();
  });

  it('줄이 하나도 없으면 null (로그인 안 됨·판본 바뀜)', () => {
    expect(parseClaudeUsageText('Please run /login', NOW)).toBeNull();
  });

  it('CLI 를 계정 디렉터리로, 세션을 남기지 않고, 도구 없이 돌린다', async () => {
    let seen: { args: string[]; env: NodeJS.ProcessEnv } | null = null;
    const r = await claudeCliUsage({
      configDir: '/acc/aria', now: NOW, probeDir: '/tmp',
      run: async (_c, args, o) => { seen = { args, env: o.env }; return { code: 0, stdout: CLAUDE_OUT }; },
    });
    expect(seen!.env.CLAUDE_CONFIG_DIR).toBe('/acc/aria');
    expect(seen!.args).toEqual(expect.arrayContaining(['-p', '/usage', '--no-session-persistence', '--allowed-tools', '']));
    expect(r.session?.usedPercent).toBe(36);
    const missing = await claudeCliUsage({ configDir: '/x', now: NOW, probeDir: '/tmp', run: async () => ({ code: null, stdout: '' }) });
    expect(missing.error).toBe('cli-unavailable');
  });
});

class FakeRpc extends EventEmitter implements RpcChild {
  stdout = new EventEmitter();
  written: unknown[] = [];
  killed = false;
  constructor(private reply: (m: { id?: number; method?: string }) => unknown) { super(); }
  stdin = {
    write: (s: string) => {
      const m = JSON.parse(s) as { id?: number; method?: string };
      this.written.push(m);
      const r = this.reply(m);
      if (r !== undefined) queueMicrotask(() => this.stdout.emit('data', Buffer.from(`${JSON.stringify(r)}\n`)));
      return true;
    },
    end: () => undefined,
  };
  kill(): boolean { this.killed = true; return true; }
}

// codex 0.154 `account/rateLimits/read` 실측 모양(값은 가짜).
const RATE = {
  rateLimits: {
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1790635491 },
    secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1791222291 },
    planType: 'plus',
  },
};

describe('codex app-server', () => {
  it('initialize → initialized → account/rateLimits/read 순서로 묻고 창을 읽는다', async () => {
    let child!: FakeRpc;
    const r = await codexCliUsage({
      codexHome: '/h', now: NOW, probeDir: '/tmp',
      spawnRpc: (home) => {
        expect(home).toBe('/h');
        child = new FakeRpc((m) => (m.id === 1 ? { id: 1, result: {} } : m.id === 2 ? { id: 2, result: RATE } : undefined));
        return child;
      },
    });
    expect(child.written.map((m) => (m as { method: string }).method)).toEqual(['initialize', 'initialized', 'account/rateLimits/read']);
    expect(r).toMatchObject({
      session: { usedPercent: 12, resetsAtMs: 1790635491000, windowMinutes: 300 },
      weekly: { usedPercent: 3, windowMinutes: 10080 },
      plan: 'plus',
    });
    expect(child.killed).toBe(true);
  });

  it('RPC 에러·무응답은 꼬리표로 끝난다(본문을 싣지 않는다)', async () => {
    const err = await codexCliUsage({
      codexHome: '/h', now: NOW, probeDir: '/tmp',
      spawnRpc: () => new FakeRpc((m) => (m.id === 1 ? { id: 1, result: {} } : m.id === 2 ? { id: 2, error: { message: 'SECRET' } } : undefined)),
    });
    expect(err.error).toBe('cli-error');
    expect(JSON.stringify(err)).not.toContain('SECRET');
    const slow = await codexCliUsage({ codexHome: '/h', now: NOW, probeDir: '/tmp', timeoutMs: 20, spawnRpc: () => new FakeRpc(() => undefined) });
    expect(slow.error).toBe('timeout');
  });

  it('parseCodexRateLimits: 모양이 없으면 null', () => {
    expect(parseCodexRateLimits({})).toBeNull();
    expect(parseCodexRateLimits(null)).toBeNull();
  });
});

describe('usageChain', () => {
  const ok = { fetchedAtMs: 0, session: { usedPercent: 1, resetsAtMs: null }, weekly: null };
  const bad = { fetchedAtMs: 0, session: null, weekly: null, error: 'cli-unavailable' };

  it('CLI 가 되면 CLI, 안 되면 API, 둘 다 안 되면 CLI 쪽 이유', async () => {
    expect(await cliThenApi(async () => ok, async () => { throw new Error('불리면 안 된다'); }))
      .toMatchObject({ source: 'cli' });
    expect(await cliThenApi(async () => bad, async () => ok)).toMatchObject({ source: 'api' });
    expect(await cliThenApi(async () => bad, async () => ({ ...bad, error: 'unauthorized' })))
      .toMatchObject({ source: 'cli', error: 'cli-unavailable' });
  });

  it('캐시: TTL 안에서는 한 번만 잰다', async () => {
    let t = 0;
    let calls = 0;
    const cache = createUsageCache(1000, () => t);
    const load = async () => { calls += 1; return ok; };
    await cache('k', load); await cache('k', load);
    expect(calls).toBe(1);
    t = 1500;
    await cache('k', load);
    expect(calls).toBe(2);
  });

  it('캐시 `stale`: TTL 이 지나면 지난 값을 곧바로 주고 뒤에서 한 번만 다시 잰다', async () => {
    let t = 0;
    let calls = 0;
    let release: ((v: typeof ok) => void) | null = null;
    const cache = createUsageCache(1000, () => t);
    const first = { ...ok, fetchedAtMs: 1 };
    await cache('k', async () => { calls += 1; return first; });
    t = 1500;
    const slow = () => { calls += 1; return new Promise<typeof ok>((r) => { release = r; }); };
    // 다시 재는 것이 끝나지 않았는데도 지난 값이 곧바로 온다.
    expect(await cache('k', slow, { stale: true })).toBe(first);
    expect(await cache('k', slow, { stale: true })).toBe(first);
    expect(calls).toBe(2); // 뒤에서 하나만 돈다
    const second = { ...ok, fetchedAtMs: 2 };
    release!(second);
    await Promise.resolve(); await Promise.resolve();
    expect(await cache('k', slow, { stale: true })).toBe(second);
    expect(calls).toBe(2);
  });

  it('캐시 `stale`: 값이 없으면 기다린다 · `stale` 없이 부르면 TTL 뒤엔 새 값을 기다린다(폴러 경로)', async () => {
    let t = 0;
    const cache = createUsageCache(1000, () => t);
    const a = { ...ok, fetchedAtMs: 1 };
    const b = { ...ok, fetchedAtMs: 2 };
    expect(await cache('k', async () => a, { stale: true })).toBe(a);
    t = 1500;
    expect(await cache('k', async () => b)).toBe(b);
  });

  it('캐시 `stale`: 뒤에서 재는 사이 `forget` 하면 옛 시도가 값을 되살리지 않는다', async () => {
    let t = 0;
    let release: ((v: typeof ok) => void) | null = null;
    const cache = createUsageCache(1000, () => t);
    const old = { ...ok, fetchedAtMs: 1 };
    await cache('k', async () => old);
    t = 1500;
    await cache('k', () => new Promise<typeof ok>((r) => { release = r; }), { stale: true });
    cache.forget('k');
    release!({ ...ok, fetchedAtMs: 2 });
    await Promise.resolve(); await Promise.resolve();
    const fresh = { ...ok, fetchedAtMs: 3 };
    expect(await cache('k', async () => fresh, { stale: true })).toBe(fresh);
  });

  it('캐시 `stale`: 뒤에서 재기가 던지면 지난 값을 지키고 다음에 다시 시도한다', async () => {
    let t = 0;
    let calls = 0;
    const cache = createUsageCache(1000, () => t);
    const old = { ...ok, fetchedAtMs: 1 };
    await cache('k', async () => old);
    t = 1500;
    expect(await cache('k', async () => { calls += 1; throw new Error('끊김'); }, { stale: true })).toBe(old);
    await Promise.resolve(); await Promise.resolve();
    expect(await cache('k', async () => { calls += 1; return ok; }, { stale: true })).toBe(old);
    expect(calls).toBe(2);
  });
  it('캐시 `force`: TTL 안이어도 새로 재고 그 값을 기다린다 · 재는 중이면 거기에 붙는다 · 다음 물음도 새 값', async () => {
    let t = 0;
    let calls = 0;
    const cache = createUsageCache(1000, () => t);
    const a = { ...ok, fetchedAtMs: 1 };
    await cache('k', async () => { calls += 1; return a; });
    let release: ((v: typeof ok) => void) | null = null;
    const slow = () => { calls += 1; return new Promise<typeof ok>((r) => { release = r; }); };
    const p1 = cache('k', slow, { force: true });
    const p2 = cache('k', slow, { force: true });
    expect(calls).toBe(2); // 연달아 눌러도 하나
    // 그 사이 화면 폴은 지난 값을 곧바로 받는다.
    expect(await cache('k', slow, { stale: true })).toBe(a);
    const b = { ...ok, fetchedAtMs: 2 };
    release!(b);
    expect(await p1).toBe(b);
    expect(await p2).toBe(b);
    expect(await cache('k', slow, { stale: true })).toBe(b);
    expect(calls).toBe(2);
  });

  it('캐시 `force`: 첫 요청이 아직 재는 중이면 새로 띄우지 않고 붙는다 · 실패하면 지난 값을 지킨다', async () => {
    let calls = 0;
    const cache = createUsageCache(1000, () => 0);
    let release: ((v: typeof ok) => void) | null = null;
    const first = cache('k', () => { calls += 1; return new Promise<typeof ok>((r) => { release = r; }); });
    const forced = cache('k', async () => { calls += 1; return ok; }, { force: true });
    expect(calls).toBe(1);
    release!(ok);
    expect(await forced).toBe(await first);
    await expect(cache('k', async () => { throw new Error('끊김'); }, { force: true })).rejects.toThrow('끊김');
    expect(await cache('k', async () => { calls += 1; return { ...ok, fetchedAtMs: 9 }; })).toBe(ok);
  });
});
