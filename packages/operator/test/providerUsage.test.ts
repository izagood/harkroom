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
