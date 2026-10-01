import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClaudeAccountsPort } from '../src/claudeAccounts.js';
import { createCodexAccountsPort } from '../src/codexAccounts.js';
import {
  CLAUDE_OAUTH_USAGE_URL,
  CODEX_WHAM_USAGE_URL,
  fetchClaudeProviderUsage,
  fetchCodexProviderUsage,
  nodeReadCodexToken,
  parseClaudeOAuthUsage,
  parseCodexWhamUsage,
  type FetchLike,
} from '../src/providerUsage.js';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const roots: string[] = [];
const temp = async (): Promise<string> => {
  const p = await mkdtemp(join(tmpdir(), 'prov-usage-'));
  roots.push(p);
  return p;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

/** 부른 URL·헤더를 적어 두는 가짜 fetch. 토큰 값은 가짜다. */
function fakeFetch(body: unknown, status = 200): FetchLike & { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return { ok: status < 400, status, json: async () => body };
  }) as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
}

describe('Claude /api/oauth/usage', () => {
  const BODY = {
    five_hour: { utilization: 42.5, resets_at: '2026-09-28T14:00:00Z' },
    seven_day: { utilization: 18, resets_at: '2026-10-01T00:00:00Z' },
    seven_day_opus: { utilization: 3, resets_at: null },
    seven_day_sonnet: null,
  };

  it('창마다 % 와 복귀 시각을 읽는다', () => {
    expect(parseClaudeOAuthUsage(BODY)).toEqual({
      session: { usedPercent: 42.5, resetsAtMs: Date.parse('2026-09-28T14:00:00Z') },
      weekly: { usedPercent: 18, resetsAtMs: Date.parse('2026-10-01T00:00:00Z') },
      extra: [{ label: 'Opus weekly', window: { usedPercent: 3, resetsAtMs: null } }],
    });
  });

  it('모르는 모양이면 던지지 않고 빈 창이다', () => {
    expect(parseClaudeOAuthUsage({ nope: 1 })).toEqual({ session: null, weekly: null, extra: [] });
    expect(parseClaudeOAuthUsage('x')).toEqual({ session: null, weekly: null, extra: [] });
  });

  it('Bearer + beta 헤더로 부르고, 에러에는 토큰을 싣지 않는다', async () => {
    const f = fakeFetch(BODY);
    const r = await fetchClaudeProviderUsage({
      configDir: '/x', now: NOW, fetchImpl: f,
      readToken: async () => ({ accessToken: 'TOKEN-A', expiresAtMs: NOW + 1000 }),
    });
    expect(f.calls[0]!.url).toBe(CLAUDE_OAUTH_USAGE_URL);
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer TOKEN-A');
    expect(f.calls[0]!.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(r.session?.usedPercent).toBe(42.5);

    const bad = await fetchClaudeProviderUsage({
      configDir: '/x', now: NOW, fetchImpl: fakeFetch({}, 401),
      readToken: async () => ({ accessToken: 'TOKEN-A', expiresAtMs: null }),
    });
    expect(bad.error).toBe('unauthorized');
    expect(JSON.stringify(bad)).not.toContain('TOKEN');
  });

  it('만료된 토큰은 부르지도 갱신하지도 않는다 — 갱신은 CLI 의 일이다', async () => {
    const f = fakeFetch(BODY);
    const r = await fetchClaudeProviderUsage({
      configDir: '/x', now: NOW, fetchImpl: f,
      readToken: async () => ({ accessToken: 'T', expiresAtMs: NOW - 1 }),
    });
    expect(r.error).toBe('token-expired');
    expect(f.calls).toEqual([]);
  });

  it('자격증명이 없으면 no-credentials', async () => {
    const r = await fetchClaudeProviderUsage({ configDir: '/x', now: NOW, fetchImpl: fakeFetch({}), readToken: async () => null });
    expect(r).toMatchObject({ error: 'no-credentials', session: null, weekly: null });
  });

  it('포트: CLI 가 되면 API 는 부르지 않는다 · CLI 가 안 되면 자동으로 API', async () => {
    const root = await temp();
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work', order: {}, agents: {} }));
    await mkdir(join(root, 'work', 'aria'), { recursive: true });
    const f = fakeFetch(BODY);
    let cliOut = 'Current session: 5% used · resets 7pm (UTC)\nCurrent week (all models): 7% used\n';
    const port = createClaudeAccountsPort({
      root, now: () => NOW, fetchImpl: f, usageCacheMs: 0,
      readToken: async () => ({ accessToken: 'T', expiresAtMs: null }),
      runCli: async (_cmd, _args, o) => {
        expect(o.env.CLAUDE_CONFIG_DIR).toBe(join(root, 'work', 'aria'));
        return { code: 0, stdout: cliOut };
      },
    });
    const ok = await port.providerUsage();
    expect(ok.accounts[0]).toMatchObject({ account: 'aria', pool: 'work', source: 'cli', weekly: { usedPercent: 7 } });
    expect(f.calls).toEqual([]);

    cliOut = 'Not logged in';
    // 화면 경로는 stale-while-revalidate 다 — TTL 이 지나도 지난 값(CLI)을 곧바로 주고 뒤에서 다시 잰다.
    const stale = await port.providerUsage();
    expect(stale.accounts[0]).toMatchObject({ source: 'cli', weekly: { usedPercent: 7 } });
    await vi.waitFor(async () => {
      const fallback = await port.providerUsage();
      expect(fallback.accounts[0]).toMatchObject({ source: 'api', weekly: { usedPercent: 18 } });
    });
    expect(f.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Codex wham/usage', () => {
  const BODY = {
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 61, limit_window_seconds: 18000, reset_at: NOW / 1000 + 3600 },
      secondary_window: { used_percent: 9, reset_after_seconds: 86400 },
    },
  };

  it('primary/secondary → 세션/주간. reset_at 과 reset_after_seconds 둘 다 읽는다', () => {
    expect(parseCodexWhamUsage(BODY, NOW)).toEqual({
      session: { usedPercent: 61, resetsAtMs: NOW + 3_600_000, windowMinutes: 300 },
      weekly: { usedPercent: 9, resetsAtMs: NOW + 86_400_000 },
      plan: 'plus',
    });
  });

  it('auth.json 의 access_token·account_id 로 부른다', async () => {
    const home = await temp();
    await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'AT', account_id: 'acc-1', id_token: 'x' } }));
    expect(await nodeReadCodexToken(home)).toEqual({ accessToken: 'AT', accountId: 'acc-1' });
    const f = fakeFetch(BODY);
    const r = await fetchCodexProviderUsage({ codexHome: home, now: NOW, fetchImpl: f });
    expect(f.calls[0]!.url).toBe(CODEX_WHAM_USAGE_URL);
    expect(f.calls[0]!.headers).toMatchObject({ Authorization: 'Bearer AT', 'ChatGPT-Account-Id': 'acc-1' });
    expect(r.session?.usedPercent).toBe(61);
  });

  it('API 키 로그인(토큰 없음)은 no-credentials', async () => {
    const home = await temp();
    await writeFile(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-x' }));
    const r = await fetchCodexProviderUsage({ codexHome: home, now: NOW, fetchImpl: fakeFetch(BODY) });
    expect(r.error).toBe('no-credentials');
  });

  it('포트: 시스템 기본(account "")과 관리 계정을 모두 싣는다 — CLI 가 없으면 API 로', async () => {
    const root = await temp();
    const systemHome = await temp();
    await mkdir(join(root, 'work'));
    const port = createCodexAccountsPort({
      root, systemHome, now: () => NOW, fetchImpl: fakeFetch(BODY),
      readToken: async () => ({ accessToken: 'T', accountId: null }),
      spawnRpc: () => { throw new Error('codex 없음'); },
    });
    const snap = await port.providerUsage();
    expect(snap.accounts.every((a) => a.source === 'api')).toBe(true);
    expect(snap.accounts.map((a) => a.account)).toEqual(['', 'work']);
    expect(snap.accounts.every((a) => a.weekly?.usedPercent === 9)).toBe(true);
  });
});

/**
 * 지운 계정 → 같은 이름으로 다시 붙인 계정에 **옛 로그인의 사용률이 나가지 않는다**(2026-10-01, #993 security 후속).
 *
 * 캐시 TTL 을 길게 잡는다 — 캐시를 버리지 않으면 같은 키(계정 디렉터리)라 옛 값이 그대로 나온다. 화면 경로는
 * stale-while-revalidate 라 TTL 이 지나도 옛 값을 한 번 더 내준다. 버리는 것이 유일한 방어다.
 */
describe('계정을 지우거나 다시 로그인하면 사용량 캐시를 버린다', () => {
  const cliSays = (pct: number) => `Current session: ${pct}% used · resets 7pm (UTC)\nCurrent week (all models): ${pct}% used\n`;

  const claudeSetup = async () => {
    const root = await temp();
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work', order: {}, agents: {} }));
    await mkdir(join(root, 'work', 'aria'), { recursive: true });
    const state = { pct: 11 };
    const port = createClaudeAccountsPort({
      root, now: () => NOW, fetchImpl: fakeFetch({}), usageCacheMs: 60 * 60 * 1000,
      readToken: async () => null,
      deleteKeychain: async () => undefined,
      runCli: async () => ({ code: 0, stdout: cliSays(state.pct) }),
    });
    return { root, port, state };
  };

  it('claude: removeAccount 뒤 같은 이름으로 다시 만들면 새 로그인의 % 다', async () => {
    const { root, port, state } = await claudeSetup();
    expect((await port.providerUsage()).accounts[0]!.weekly?.usedPercent).toBe(11);
    await port.removeAccount('work', 'aria');
    await mkdir(join(root, 'work', 'aria'), { recursive: true });
    state.pct = 64;
    expect((await port.providerUsage()).accounts[0]!.weekly?.usedPercent).toBe(64);
  });

  it('claude: removePool 은 그 풀 아래 계정의 캐시를 전부 버린다 · 다른 풀은 건드리지 않는다', async () => {
    const { root, port, state } = await claudeSetup();
    await mkdir(join(root, 'workshop', 'aria'), { recursive: true });
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work', order: { work: [], workshop: [] }, agents: {} }));
    const pctOf = async (pool: string) => (await port.providerUsage()).accounts.find((a) => a.pool === pool)!.weekly?.usedPercent;
    expect(await pctOf('work')).toBe(11);
    expect(await pctOf('workshop')).toBe(11);
    await port.removePool('work');
    await mkdir(join(root, 'work', 'aria'), { recursive: true });
    state.pct = 64;
    expect(await pctOf('work')).toBe(64);
    // 이름 앞부분이 같은 풀(`work` ⊂ `workshop`)의 캐시는 남는다 — 경로 구분자로 자른다.
    expect(await pctOf('workshop')).toBe(11);
  });

  const codexBody = (pct: number) => ({
    rate_limit: { primary_window: { used_percent: pct, reset_after_seconds: 60 }, secondary_window: { used_percent: pct, reset_after_seconds: 60 } },
  });

  const codexSetup = async () => {
    const root = await temp();
    const systemHome = await temp();
    await mkdir(join(root, 'work'));
    const state = { pct: 11 };
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => codexBody(state.pct) }) as never;
    const children: (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill(): boolean })[] = [];
    const port = createCodexAccountsPort({
      root, systemHome, now: () => NOW, fetchImpl, usageCacheMs: 60 * 60 * 1000,
      readToken: async () => ({ accessToken: 'T', accountId: null }),
      spawnRpc: () => { throw new Error('codex 없음'); },
      status: async (home) => ({ loggedIn: home.startsWith(root) }) as never,
      spawnLogin: () => {
        const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
        children.push(c);
        return c as never;
      },
    });
    const pctOf = async () => (await port.providerUsage()).accounts.find((a) => a.account === 'work')!.weekly?.usedPercent;
    return { root, port, state, children, pctOf };
  };

  it('codex: removeAccount 뒤 같은 이름으로 다시 만들면 새 로그인의 % 다', async () => {
    const { root, port, state, pctOf } = await codexSetup();
    expect(await pctOf()).toBe(11);
    await port.removeAccount('work');
    await mkdir(join(root, 'work'));
    state.pct = 64;
    expect(await pctOf()).toBe(64);
  });

  it('codex: 로그인이 끝나면(다시 로그인) 그 계정의 캐시를 버린다', async () => {
    const { port, state, children, pctOf } = await codexSetup();
    expect(await pctOf()).toBe(11);
    const done = new Promise<void>((res) => port.onLoginEvent((e) => { if (e.done) res(); }));
    await port.loginStart('work');
    state.pct = 64;
    children[0]!.emit('exit', 0);
    await done;
    expect(await pctOf()).toBe(64);
  });
});
