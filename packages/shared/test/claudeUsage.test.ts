import { describe, expect, it } from 'vitest';

import { CLAUDE_USAGE_STALE_MS, isUsageFresh, parseClaudeUsageFile } from '../src/claudeUsage.js';

describe('parseClaudeUsageFile', () => {
  it('깨졌거나 모르는 판본이면 빈 스냅숏 — 던지지 않는다', () => {
    expect(parseClaudeUsageFile(null).accounts).toEqual([]);
    expect(parseClaudeUsageFile({ version: 2, accounts: [{ account: 'a' }] }).accounts).toEqual([]);
  });

  it('틀린 항목만 버리고 나머지는 살린다', () => {
    const f = parseClaudeUsageFile({
      version: 1, writtenAtMs: 5,
      accounts: [
        { account: '' },
        'x',
        {
          pool: 'work', account: 'aria', signIn: 'abc',
          session: { usedPercent: 140, resetsAtMs: 9 }, weekly: { usedPercent: 'x' },
          modelWeekly: [{ label: 'Opus weekly', window: { usedPercent: 3, resetsAtMs: null } }, { label: 1 }],
          readAtMs: 4, error: 'timeout',
        },
      ],
    });
    expect(f.writtenAtMs).toBe(5);
    expect(f.accounts).toEqual([{
      pool: 'work', account: 'aria', signIn: 'abc',
      session: { usedPercent: 100, resetsAtMs: 9 }, weekly: null,
      modelWeekly: [{ label: 'Opus weekly', window: { usedPercent: 3, resetsAtMs: null } }],
      readAtMs: 4, error: 'timeout',
    }]);
  });
});

describe('isUsageFresh', () => {
  const e = { pool: '', account: 'a', signIn: null, session: null, weekly: null, modelWeekly: [] };
  it('못 읽었거나 10분을 넘으면 믿지 않는다', () => {
    expect(isUsageFresh({ ...e, readAtMs: null }, 0)).toBe(false);
    expect(isUsageFresh({ ...e, readAtMs: 0 }, CLAUDE_USAGE_STALE_MS)).toBe(true);
    expect(isUsageFresh({ ...e, readAtMs: 0 }, CLAUDE_USAGE_STALE_MS + 1)).toBe(false);
  });
});
