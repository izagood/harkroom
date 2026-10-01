/**
 * 사용량 폴러(C ①) — 기한·실패 보존·파일 모양.
 *
 * `measure` 를 주입한다. 실제 `claude` 를 띄우면 이 테스트가 그 머신의 로그인에 달리고, CI 에는
 * 로그인이 없다. 재는 것은 **언제 누구를 재고 무엇을 쓰는가**다.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseClaudeUsageFile } from '@harkroom/shared/claudeUsage';

import { readSignInKey } from '../src/claudeAccounts.js';
import { createClaudeUsagePoller, USAGE_POLL_ACTIVE_MS, USAGE_POLL_IDLE_MS } from '../src/claudeUsagePoller.js';

const T0 = Date.parse('2026-09-29T12:00:00Z');
const RESET = T0 + 3 * 3600_000;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function poolsRoot(accounts: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'usage-poll-'));
  roots.push(root);
  await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work', order: {}, agents: {} }));
  for (const a of accounts) await mkdir(join(root, 'work', a), { recursive: true });
  return root;
}

const readFileAt = async (root: string) =>
  parseClaudeUsageFile(JSON.parse(await readFile(join(root, 'usage.json'), 'utf8')));

function setup(root: string) {
  let clock = T0;
  const pct: Record<string, number | 'fail'> = {};
  const calls: string[] = [];
  const poller = createClaudeUsagePoller({
    root,
    now: () => clock,
    readSignIn: async () => null,
    measure: async (dir) => {
      const name = dir.split('/').pop()!;
      calls.push(name);
      const p = pct[name] ?? 0;
      if (p === 'fail') return { fetchedAtMs: clock, session: null, weekly: null, error: 'timeout' };
      return {
        fetchedAtMs: clock,
        session: { usedPercent: p, resetsAtMs: RESET },
        weekly: { usedPercent: p / 2, resetsAtMs: RESET + 86_400_000 },
        extra: [{ label: 'Opus weekly', window: { usedPercent: 1, resetsAtMs: null } }],
      };
    },
  });
  return { poller, pct, calls, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

describe('claudeUsagePoller', () => {
  it('처음에는 모든 계정을 재고 usage.json 에 %·초기화 시각·읽은 시각을 쓴다', async () => {
    const root = await poolsRoot(['aria', 'bex']);
    const s = setup(root);
    s.pct.aria = 40;
    await s.poller.tick();
    expect(s.calls.sort()).toEqual(['aria', 'bex']);
    const f = await readFileAt(root);
    const aria = f.accounts.find((a) => a.account === 'aria')!;
    expect(aria).toMatchObject({
      pool: 'work', signIn: null, readAtMs: T0,
      session: { usedPercent: 40, resetsAtMs: RESET },
      weekly: { usedPercent: 20 },
      modelWeekly: [{ label: 'Opus weekly', window: { usedPercent: 1 } }],
    });
    expect(aria.error).toBeUndefined();
    expect(f.writtenAtMs).toBe(T0);
  });

  it('값이 움직인 계정은 2분, 가만한 계정은 10분마다 잰다', async () => {
    const root = await poolsRoot(['aria', 'bex']);
    const s = setup(root);
    s.pct.aria = 10;
    await s.poller.tick();
    s.advance(USAGE_POLL_ACTIVE_MS);
    s.pct.aria = 12; // 움직였다 → 쓰이는 계정
    s.calls.length = 0;
    await s.poller.tick();
    // 두 번째 조회 전에는 어느 쪽도 "움직였다"를 모른다 — 둘 다 10분 기한이라 아직 안 잰다.
    expect(s.calls).toEqual([]);
    s.advance(USAGE_POLL_IDLE_MS - USAGE_POLL_ACTIVE_MS);
    await s.poller.tick();
    expect(s.calls.sort()).toEqual(['aria', 'bex']);
    s.calls.length = 0;
    s.advance(USAGE_POLL_ACTIVE_MS);
    await s.poller.tick();
    expect(s.calls).toEqual(['aria']);
  });

  it('조회가 실패하면 앞 값과 readAtMs 를 지우지 않고 error 만 싣는다', async () => {
    const root = await poolsRoot(['aria']);
    const s = setup(root);
    s.pct.aria = 50;
    await s.poller.tick();
    s.advance(USAGE_POLL_IDLE_MS);
    s.pct.aria = 'fail';
    await s.poller.tick();
    const aria = (await readFileAt(root)).accounts[0]!;
    expect(aria).toMatchObject({ readAtMs: T0, session: { usedPercent: 50 }, error: 'timeout' });
  });

  it('한 번도 못 읽은 계정은 창 없이 readAtMs null', async () => {
    const root = await poolsRoot(['aria']);
    const s = setup(root);
    s.pct.aria = 'fail';
    await s.poller.tick();
    expect((await readFileAt(root)).accounts[0]).toMatchObject({ session: null, weekly: null, readAtMs: null, error: 'timeout' });
  });

  it('디스크에서 사라진 계정은 파일에서도 빠진다', async () => {
    const root = await poolsRoot(['aria', 'bex']);
    const s = setup(root);
    await s.poller.tick();
    await rm(join(root, 'work', 'bex'), { recursive: true });
    s.advance(1000);
    await s.poller.tick();
    expect((await readFileAt(root)).accounts.map((a) => a.account)).toEqual(['aria']);
  });

  it('forget 은 기한 전이어도 그 계정만 곧바로 다시 잰다 — 다시 로그인한 계정', async () => {
    const root = await poolsRoot(['aria', 'cedar']);
    const s = setup(root);
    s.pct.aria = 40;
    await s.poller.tick();
    s.calls.length = 0;
    s.pct.aria = 5; // 새 로그인의 값
    s.advance(1000);
    await s.poller.forget(join(root, 'work', 'aria'));
    expect(s.calls).toEqual(['aria']);
    const file = await readFileAt(root);
    expect(file?.accounts.find((a) => a.account === 'aria')?.session?.usedPercent).toBe(5);
  });

  it('겹쳐 부르면 조회는 한 번이다', async () => {
    const root = await poolsRoot(['aria']);
    const s = setup(root);
    await Promise.all([s.poller.tick(), s.poller.tick()]);
    expect(s.calls).toEqual(['aria']);
  });
});

describe('readSignInKey', () => {
  it('같은 로그인이면 같은 키, 식별자 원문은 싣지 않는다', async () => {
    const root = await poolsRoot(['aria', 'bex', 'cy']);
    const oauth = (org: string, acct: string) =>
      JSON.stringify({ oauthAccount: { organizationUuid: org, accountUuid: acct, emailAddress: 'a@example.com' } });
    await writeFile(join(root, 'work', 'aria', '.claude.json'), oauth('org-1', 'acct-1'));
    await writeFile(join(root, 'work', 'bex', '.claude.json'), oauth('org-1', 'acct-1'));
    const a = await readSignInKey(join(root, 'work', 'aria'));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain('org-1');
    expect(await readSignInKey(join(root, 'work', 'bex'))).toBe(a);
    expect(await readSignInKey(join(root, 'work', 'cy'))).toBeNull();
  });
});
