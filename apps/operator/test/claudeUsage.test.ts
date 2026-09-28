/**
 * 사용량 관측 — **실제 트랜스크립트 모양으로** 잰다.
 *
 * 픽스처의 레코드 모양은 실물에서 옮긴 것이다(claude 2.1.263, 2026-09-09):
 * assistant 레코드의 `message.usage` 에 `input_tokens`·`output_tokens`·
 * `cache_read_input_tokens`·`cache_creation_input_tokens` 가 있고, 한도에 걸린 순간에는
 * **최상위** `quotaLimits`(`status: 'rejected'`·`resetsAt`(초)·`rateLimitType`)가 붙은
 * `model: '<synthetic>'` 레코드가 남는다.
 *
 * **시계를 주입한다.** 5시간 창은 시계에 달린 판정이라 `Date.now()` 로 재면 이 테스트가
 * 도는 시각에 달린다(`claudeAccounts.test.ts` 가 `claude auth status` 를 주입한 것과 같은 이유).
 */
import { mkdtempSync, utimesSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createClaudeAccountsPort } from '../src/claudeAccounts.js';
import { USAGE_WINDOW_MS } from '../src/claudeUsage.js';

const NOW = Date.parse('2026-09-09T12:00:00.000Z');

function port(root: string) {
  return createClaudeAccountsPort({
    root,
    runStatus: vi.fn(async () => ({ loggedIn: true })),
    now: () => NOW,
  });
}

function assistant(atMs: number, id: string, u: Partial<Record<string, number>>): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(atMs).toISOString(),
    uuid: `u-${id}`,
    message: {
      id, role: 'assistant', model: 'claude-opus-5',
      usage: {
        input_tokens: u.input ?? 0,
        output_tokens: u.output ?? 0,
        cache_read_input_tokens: u.cacheRead ?? 0,
        cache_creation_input_tokens: u.cacheCreation ?? 0,
      },
    },
  });
}

function rejected(atMs: number, resetsAtSec: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(atMs).toISOString(),
    uuid: `u-rej-${atMs}`,
    message: {
      id: `rej-${atMs}`, role: 'assistant', model: '<synthetic>',
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: 'text', text: "You've hit your session limit · resets 4:30pm" }],
    },
    quotaLimits: {
      status: 'rejected', resetsAt: resetsAtSec, rateLimitType: 'five_hour',
      overageStatus: 'rejected', isUsingOverage: false,
    },
  });
}

/** 계정 하나에 트랜스크립트 파일 하나를 깐다. **mtime 을 정한다** — 창 밖 파일은 열리지 않는다. */
async function transcript(
  root: string, pool: string, account: string, file: string, lines: string[], mtimeMs = NOW,
): Promise<void> {
  const dir = join(root, pool, account, 'projects', '-some-project');
  await mkdir(dir, { recursive: true });
  const path = join(dir, file);
  await writeFile(path, `${lines.join('\n')}\n`);
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
}

async function poolRoot(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'd-usage-'));
  await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work' }));
  return root;
}

describe('usage', () => {
  it('창 안의 토큰을 갈래별로 더하고, 캐시 읽기를 입력에 섞지 않는다', async () => {
    const root = await poolRoot();
    await transcript(root, 'work', 'lime', 's1.jsonl', [
      assistant(NOW - 60_000, 'm1', { input: 10, output: 100, cacheRead: 5_000, cacheCreation: 200 }),
      assistant(NOW - 30_000, 'm2', { input: 20, output: 300, cacheRead: 7_000, cacheCreation: 0 }),
    ]);
    const snap = await port(root).usage();
    expect(snap.windowMs).toBe(USAGE_WINDOW_MS);
    expect(snap.measuredAtMs).toBe(NOW);
    const u = snap.accounts.find((a) => a.account === 'lime')!;
    expect(u.pool).toBe('work');
    expect(u.responses).toBe(2);
    expect(u.tokens).toEqual({ input: 30, output: 400, cacheRead: 12_000, cacheCreation: 200 });
  });

  it('창보다 오래된 레코드는 세지 않는다 — 파일이 창 안에 있어도', async () => {
    const root = await poolRoot();
    await transcript(root, 'work', 'lime', 's1.jsonl', [
      assistant(NOW - USAGE_WINDOW_MS - 60_000, 'old', { input: 999, output: 999 }),
      assistant(NOW - 60_000, 'new', { input: 1, output: 2 }),
    ]);
    const u = (await port(root).usage()).accounts[0]!;
    expect(u.responses).toBe(1);
    expect(u.tokens.input).toBe(1);
  });

  it('창 밖에서 마지막으로 쓰인 파일은 열지 않지만, 마지막 사용 시각은 준다', async () => {
    const root = await poolRoot();
    const long = NOW - USAGE_WINDOW_MS - 3_600_000;
    await transcript(root, 'work', 'lime', 'old.jsonl', [
      // 파일 mtime 이 창 밖이므로 **이 줄은 읽히지 않는다.** 시각이 창 안이어도 그렇다 —
      // 그 조합은 실물에서 나오지 않는다(레코드 시각 ≤ 파일 mtime).
      assistant(NOW - 60_000, 'unreachable', { input: 777, output: 777 }),
    ], long);
    const u = (await port(root).usage()).accounts[0]!;
    expect(u.responses).toBe(0);
    expect(u.tokens.input).toBe(0);
    expect(u.lastUsedAtMs).toBe(long);
  });

  it('같은 `message.id` 를 두 파일에서 보면 한 번만 센다 — 세션을 갈라내면 복사된다', async () => {
    const root = await poolRoot();
    const line = assistant(NOW - 60_000, 'same-id', { input: 100, output: 10 });
    await transcript(root, 'work', 'lime', 's1.jsonl', [line]);
    await transcript(root, 'work', 'lime', 's2-fork.jsonl', [line]);
    const u = (await port(root).usage()).accounts[0]!;
    expect(u.responses).toBe(1);
    expect(u.tokens.input).toBe(100);
  });

  it('`<synthetic>` 레코드는 응답으로 세지 않는다', async () => {
    const root = await poolRoot();
    await transcript(root, 'work', 'lime', 's1.jsonl', [
      rejected(NOW - 60_000, Math.floor((NOW + 600_000) / 1000)),
    ]);
    const u = (await port(root).usage()).accounts[0]!;
    expect(u.responses).toBe(0);
  });

  it('한도 사건의 `resetsAt` 을 ms 로 주고, 미래면 창을 그 창으로 좁힌다', async () => {
    const root = await poolRoot();
    const resetsAtMs = NOW + 20 * 60_000; // 20분 뒤에 풀린다 → 지금 소진 중이다.
    await transcript(root, 'work', 'lime', 's1.jsonl', [
      // **이전 창**의 응답. 롤링 5시간이면 세어지고, claude 가 말한 창이면 안 세어진다.
      assistant(resetsAtMs - USAGE_WINDOW_MS - 60_000, 'prev', { input: 500, output: 500 }),
      assistant(NOW - 60_000, 'cur', { input: 7, output: 8 }),
      rejected(NOW - 30_000, Math.floor(resetsAtMs / 1000)),
    ]);
    const u = (await port(root).usage()).accounts[0]!;
    expect(u.limitHit).toEqual({ atMs: NOW - 30_000, resetsAtMs, rateLimitType: 'five_hour' });
    expect(u.windowStartMs).toBe(resetsAtMs - USAGE_WINDOW_MS);
    expect(u.responses).toBe(1);
    expect(u.tokens.input).toBe(7);
  });

  it('`resetsAt` 이 이미 지났으면 창은 롤링 5시간이다', async () => {
    const root = await poolRoot();
    await transcript(root, 'work', 'lime', 's1.jsonl', [
      rejected(NOW - 3 * 3_600_000, Math.floor((NOW - 2 * 3_600_000) / 1000)),
      assistant(NOW - 4 * 3_600_000, 'a', { input: 3, output: 3 }),
    ]);
    const u = (await port(root).usage()).accounts[0]!;
    expect(u.windowStartMs).toBe(NOW - USAGE_WINDOW_MS);
    expect(u.responses).toBe(1);
  });

  it('본문에 `quotaLimits` 라는 낱말이 있는 발화를 한도 사건으로 읽지 않는다', async () => {
    const root = await poolRoot();
    await transcript(root, 'work', 'lime', 's1.jsonl', [
      JSON.stringify({
        type: 'user', timestamp: new Date(NOW - 60_000).toISOString(),
        message: { role: 'user', content: '트랜스크립트의 "quotaLimits" 에 "usage" 가 있다' },
      }),
    ]);
    const u = (await port(root).usage()).accounts[0]!;
    expect(u.limitHit).toBeNull();
  });

  it('트랜스크립트가 없는 계정도 줄로 나오고, 마지막 사용 시각이 `null` 이다', async () => {
    const root = await poolRoot();
    await mkdir(join(root, 'work', 'fresh'), { recursive: true });
    const u = (await port(root).usage()).accounts.find((a) => a.account === 'fresh')!;
    expect(u.lastUsedAtMs).toBeNull();
    expect(u.responses).toBe(0);
    expect(u.limitHit).toBeNull();
  });

  it('풀 모드에서 계정 여럿을 각각 센다 — 하나가 소진이어도 다른 것의 창은 롤링이다', async () => {
    const root = await poolRoot();
    const resetsAtMs = NOW + 10 * 60_000;
    await transcript(root, 'work', 'lime', 's.jsonl', [rejected(NOW - 60_000, Math.floor(resetsAtMs / 1000))]);
    await transcript(root, 'work', 'plum', 's.jsonl', [assistant(NOW - 60_000, 'p1', { input: 5, output: 6 })]);
    const snap = await port(root).usage();
    const lime = snap.accounts.find((a) => a.account === 'lime')!;
    const plum = snap.accounts.find((a) => a.account === 'plum')!;
    expect(lime.limitHit?.resetsAtMs).toBe(resetsAtMs);
    expect(lime.windowStartMs).toBe(resetsAtMs - USAGE_WINDOW_MS);
    expect(plum.limitHit).toBeNull();
    expect(plum.windowStartMs).toBe(NOW - USAGE_WINDOW_MS);
  });

  it('평평한 구조에서는 풀 이름이 빈 문자열이다 — 목록과 같은 규칙', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd-usage-flat-'));
    const dir = join(root, 'solo', 'projects', '-p');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 's.jsonl'), `${assistant(NOW - 60_000, 'x', { input: 1, output: 1 })}\n`);
    const snap = await createClaudeAccountsPort({
      root, runStatus: vi.fn(async () => ({ loggedIn: true })), now: () => NOW,
    }).usage();
    expect(snap.accounts).toHaveLength(1);
    expect(snap.accounts[0]!.pool).toBe('');
    expect(snap.accounts[0]!.account).toBe('solo');
  });

  it('쓰다 만 마지막 줄이 있어도 앞의 레코드를 센다', async () => {
    const root = await poolRoot();
    await transcript(root, 'work', 'lime', 's1.jsonl', [
      assistant(NOW - 60_000, 'ok', { input: 4, output: 5 }),
      '{"type":"assistant","message":{"usage":{"input_tok',
    ]);
    const u = (await port(root).usage()).accounts[0]!;
    expect(u.responses).toBe(1);
    expect(u.unreadableFiles).toBe(0);
  });
});
