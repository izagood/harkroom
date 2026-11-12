import { describe, expect, it } from 'vitest';
import { translator } from '../src/i18n';
import { accountChipOf } from '../src/lib/accountChip';

const t = translator('ko');

describe('accountChipOf — 턴 줄 칩과 설정 「최근 턴」 줄이 같이 쓰는 글', () => {
  it('내려온 칩은 툴팁에서 내려온 까닭이 먼저 읽힌다(designer n1)', () => {
    const c = accountChipOf(t, 2, 1)!;
    expect(c).toMatchObject({ label: '↓ 풀 2 · 계정 1', fell: true });
    expect(c.title.startsWith('앞 풀이 소진돼 2번 풀로 내려와 돈다 · ')).toBe(true);
    expect(c.title).toContain('이름은 이 턴이 도는 기기에서만 보인다');
  });
  it('기본 로그인이어도 내려왔으면 「↓」(designer n2)', () => {
    expect(accountChipOf(t, 2, null)).toMatchObject({ label: '↓ 기본 로그인', fell: true });
    expect(accountChipOf(t, null, null)).toMatchObject({ label: '기본 로그인', fell: false });
  });
  it('모르면 그리지 않는다 — 이름 문자열·범위 밖 숫자는 순번이 아니다', () => {
    expect(accountChipOf(t, 1, undefined)).toBeNull();
    expect(accountChipOf(t, null, 'lychee')).toBeNull();
    expect(accountChipOf(t, 'work', 0)).toBeNull();
  });
});
