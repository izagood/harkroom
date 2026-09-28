/**
 * 기동 lane 을 글자로 만드는 판정. **셋을 가르는 것**이 이 회귀선의 전부다 —
 * 모른다(신고 없음) · 풀이 비었다 · 순서가 있다. 셋 중 둘을 붙이면 화면이 확인한 적
 * 없는 것을 단언한다(#683 의 `0` vs `모름` 과 같은 규율).
 */
import { describe, expect, it } from 'vitest';

import { claudeLaneLabel, showsClaudeLane } from '../src/lib/claudeLane';
import { translator } from '../src/i18n';

const t = translator('en');

describe('claudeLaneLabel', () => {
  it('신고가 없으면 모른다고 말한다 — 빈 풀이라고 적지 않는다', () => {
    const s = claudeLaneLabel(null, t);
    expect(s).toContain('Not reported');
    expect(s).not.toContain('empty');
  });

  it('풀이 비면 시스템 기본 로그인이라고 말한다 — 모른다와 다른 문장이다', () => {
    const s = claudeLaneLabel({ pool: 'work', accounts: [] }, t);
    expect(s).toContain('work');
    expect(s).toContain('system login');
    expect(s).not.toContain('Not reported');
  });

  it('풀 지정이 없으면 빈 이름을 그리지 않고 기본 풀이라고 적는다', () => {
    expect(claudeLaneLabel({ pool: null, accounts: [] }, t)).toContain('default pool');
  });

  it('계정 순서를 그대로 잇는다 — 정렬하면 페일오버 순서가 사라진다', () => {
    expect(claudeLaneLabel({ pool: 'work', accounts: ['plum', 'lime', 'lychee'] }, t))
      .toBe('work: plum → lime → lychee');
  });

  it('계정 하나여도 순서 문장을 쓴다 — 특례를 만들지 않는다', () => {
    expect(claudeLaneLabel({ pool: null, accounts: ['max'] }, t)).toBe('the default pool: max');
  });
});

describe('showsClaudeLane', () => {
  it('claude 하네스에만 그린다 — codex 에이전트에게 claude 계정 목록을 그리지 않는다', () => {
    expect(showsClaudeLane('claude-code')).toBe(true);
    expect(showsClaudeLane('codex')).toBe(false);
    expect(showsClaudeLane('gemini')).toBe(false);
  });
});
