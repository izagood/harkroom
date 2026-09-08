/**
 * 사용량을 **글자로 만드는 판정**의 회귀선. 순수 함수라 렌더 없이 잰다.
 *
 * 여기서 지키는 것은 숫자 포맷이 아니라 **말하지 않기로 한 것들**이다: 퍼센트를 내지
 * 않는다(분모를 모른다), 안 온 것을 `0` 으로 그리지 않는다, 이미 풀린 한도를 경고로
 * 그리지 않는다. 셋 다 화면이 확인한 적 없는 것을 단언하지 않게 하는 줄이다.
 */
import { describe, expect, it } from 'vitest';

import {
  clockLabel,
  compactTokens,
  lastUsedLabel,
  limitLine,
  usageByAccount,
  usageSummary,
} from '../src/lib/claudeUsage';
import type { ClaudeAccountUsage } from '../src/lib/claudeAccounts';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);

function usage(over: Partial<ClaudeAccountUsage> = {}): ClaudeAccountUsage {
  return {
    pool: 'work',
    account: 'lime',
    windowStartMs: NOW - 5 * HOUR,
    tokens: { input: 12_345, output: 6_789, cacheRead: 45_000_000, cacheCreation: 1_000 },
    responses: 42,
    lastUsedAtMs: NOW - HOUR,
    limitHit: null,
    unreadableFiles: 0,
    ...over,
  };
}

describe('compactTokens', () => {
  it('자리를 하나만 남긴다 — 옆 계정과 눈으로 비교할 숫자다', () => {
    expect(compactTokens(0)).toBe('0');
    expect(compactTokens(999)).toBe('999');
    expect(compactTokens(12_345)).toBe('12.3k');
    expect(compactTokens(45_000_000)).toBe('45.0M');
  });

  it('음수·NaN 은 0 이다 — 트랜스크립트가 이상한 값을 줘도 화면은 숫자를 그린다', () => {
    expect(compactTokens(-1)).toBe('0');
    expect(compactTokens(Number.NaN)).toBe('0');
  });
});

describe('usageSummary', () => {
  it('캐시 읽기를 입력에 더하지 않는다 — 더하면 화면이 캐시 읽기 하나가 된다', () => {
    const s = usageSummary(usage());
    // 입력은 input+cacheCreation(=13.3k)이고 캐시 읽기 45.0M 은 자기 자리에 따로 선다.
    expect(s).toContain('in 13.3k');
    expect(s).toContain('cache 45.0M');
    expect(s).not.toContain('in 45.0M');
  });

  it('퍼센트를 내지 않는다 — 분모가 어디에도 없다', () => {
    expect(usageSummary(usage())).not.toContain('%');
  });

  it('응답이 0 이면 양이 아니라 "안 돌았다"고 말한다', () => {
    const s = usageSummary(usage({ responses: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } }));
    expect(s).toBe('Not used in this window');
    expect(s).not.toContain('0 tokens');
  });

  it('못 읽은 파일이 있으면 숫자가 하한이라는 사실을 숨기지 않는다', () => {
    expect(usageSummary(usage({ unreadableFiles: 3 }))).toContain('+3 files unreadable');
    expect(usageSummary(usage({ unreadableFiles: 1 }))).toContain('+1 file unreadable');
    expect(usageSummary(usage())).not.toContain('unreadable');
  });
});

describe('limitLine', () => {
  it('한도 사건이 없으면 아무 말도 하지 않는다', () => {
    expect(limitLine(usage(), NOW, 'en')).toBeNull();
  });

  it('resetsAt 이 미래면 경고이고 복귀 시각을 말한다', () => {
    const line = limitLine(
      usage({ limitHit: { atMs: NOW - HOUR, resetsAtMs: NOW + 2 * HOUR, rateLimitType: 'five_hour' } }),
      NOW,
      'en',
      'UTC',
    );
    expect(line?.tone).toBe('warning');
    expect(line?.text).toBe('Rate limited — resets 14:00');
  });

  it('이미 풀린 한도는 경고가 아니다 — 그래도 이 창에서 걸린 사실은 남긴다', () => {
    const line = limitLine(
      usage({ limitHit: { atMs: NOW - 2 * HOUR, resetsAtMs: NOW - HOUR, rateLimitType: 'five_hour' } }),
      NOW,
      'en',
    );
    expect(line?.tone).toBe('muted');
    expect(line?.text).toContain('earlier in this window');
  });

  it('창보다 앞선 사건은 이 창의 일이 아니다 — 옛 소진을 지금 일로 그리지 않는다', () => {
    expect(
      limitLine(
        usage({ limitHit: { atMs: NOW - 9 * HOUR, resetsAtMs: NOW - 8 * HOUR, rateLimitType: 'five_hour' } }),
        NOW,
        'en',
      ),
    ).toBeNull();
  });

  it('resetsAt 이 없어도 걸렸다는 사실은 말한다 — 다만 시각을 지어내지 않는다', () => {
    const line = limitLine(usage({ limitHit: { atMs: NOW - HOUR, resetsAtMs: null, rateLimitType: null } }), NOW, 'en');
    expect(line?.tone).toBe('muted');
    expect(line?.text).not.toContain('resets');
  });
});

describe('lastUsedLabel', () => {
  it('쓴 적 없음은 0 이 아니라 "Never used" 다', () => {
    expect(lastUsedLabel(usage({ lastUsedAtMs: null }), 'en')).toBe('Never used');
  });

  it('시각으로 말한다 — 사람이 시계를 보고 대조한다', () => {
    expect(lastUsedLabel(usage({ lastUsedAtMs: NOW - HOUR }), 'en', 'UTC')).toBe('Last active 11:00');
  });
});

describe('clockLabel', () => {
  it('24시간 표기다 — 시간대를 주면 그 시간대로 읽는다', () => {
    expect(clockLabel(Date.UTC(2026, 8, 9, 7, 30), 'en', 'Asia/Seoul')).toBe('16:30');
  });
});

describe('usageByAccount', () => {
  it('풀+계정으로 짝을 맞춘다 — 다른 풀의 같은 이름이 섞이면 남의 사용량을 그린다', () => {
    const m = usageByAccount([
      usage({ pool: 'work', account: 'lime', responses: 1 }),
      usage({ pool: 'jaebin', account: 'lime', responses: 2 }),
    ]);
    expect(m.get('work/lime')?.responses).toBe(1);
    expect(m.get('jaebin/lime')?.responses).toBe(2);
  });

  it('사용량이 아직 없으면 빈 표다 — 화면이 "안 왔다"를 그릴 수 있게 undefined 를 준다', () => {
    expect(usageByAccount(null).get('work/lime')).toBeUndefined();
  });
});
