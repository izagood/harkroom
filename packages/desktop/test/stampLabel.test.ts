import { describe, it, expect } from 'vitest';
import { stampLabel } from '../src/lib/day';

/**
 * **시각 도장이 어느 날 것인지 말하는가**(2026-09-10 보고: *"시간만 있고 날짜가 없어서
 * 하루가 지나면 언제 작성된 내용인지 알 수가 없어"*).
 *
 * 글자를 통째로 박아 두지 않는다 — 오전/오후 같은 `Intl` 의 말은 엔진의 ICU 판마다
 * 다르게 나온다(같은 `ko` 가 Node 22 에서 `PM`, JavaScriptCore 에서 `오후`). 이 축들이
 * 재는 것은 **날짜가 붙는가 안 붙는가**이지 그 언어의 철자가 아니므로, 날짜 부분은
 * 구분선과 같은 어휘(`toLocaleDateString`)와 맞춰 보고 시각 부분은 오늘 표기와 맞춰 본다.
 */
const local = (y: number, m: number, d: number, h: number, min = 0): Date => new Date(y, m - 1, d, h, min);

describe('stampLabel', () => {
  const now = local(2026, 9, 10, 12, 0);

  it('오늘 것은 시각만 낸다 — 날짜는 붙지 않는다', () => {
    const label = stampLabel(local(2026, 9, 10, 23, 26).toISOString(), 'ko', now);
    expect(label).not.toContain('2026');
    expect(label).toContain('11');
    expect(label).toContain('26');
  });

  it('다른 날 것은 연·월·일을 함께 낸다', () => {
    const at = local(2026, 9, 9, 23, 26);
    const label = stampLabel(at.toISOString(), 'ko', now);
    // 날짜 어휘는 구분선(`dayLabel`)의 절대 날짜와 같다.
    expect(label).toContain(at.toLocaleDateString('ko'));
    // 시각 부분은 오늘 표기 그대로다 — 날짜가 앞에 붙을 뿐이다.
    expect(label).toContain(stampLabel(local(2026, 9, 10, 23, 26).toISOString(), 'ko', now));
  });

  it('어제도 예외가 아니다 — 상대어(`어제`)가 아니라 날짜를 적는다', () => {
    const label = stampLabel(local(2026, 9, 9, 10, 0).toISOString(), 'ko', now);
    expect(label).not.toContain('어제');
    expect(label).toContain('2026');
  });

  it('경계는 로컬 자정이다 — 1분 차이로 날짜가 붙고 떨어진다', () => {
    expect(stampLabel(local(2026, 9, 10, 0, 1).toISOString(), 'ko', now)).not.toContain('2026');
    expect(stampLabel(local(2026, 9, 9, 23, 59).toISOString(), 'ko', now)).toContain('2026');
  });

  it('해가 바뀌어도 같은 달·일이면 오늘로 착각하지 않는다', () => {
    const label = stampLabel(local(2025, 9, 10, 12, 0).toISOString(), 'ko', now);
    expect(label).toContain('2025');
  });

  it('언어를 따른다 — 날짜 순서는 우리가 정하지 않는다', () => {
    const at = local(2026, 9, 9, 23, 26);
    expect(stampLabel(at.toISOString(), 'en', now)).toContain(at.toLocaleDateString('en'));
  });
});
