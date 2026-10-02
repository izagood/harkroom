import { describe, expect, it } from 'vitest';
import { highlightParts, searchExcerpt } from '../src/lib/highlight';

const marked = (text: string, q: string) =>
  highlightParts(text, q).map((p) => (p.hit ? `[${p.text}]` : p.text)).join('');

describe('highlightParts — ⌘K 결과 강조', () => {
  it('낱말마다, 대소문자 없이, 긴 낱말이 이긴다', () => {
    expect(marked('서버 최신버전 배포해', '배포')).toBe('서버 최신버전 [배포]해');
    expect(marked('SearchPalette.tsx 를 고침', 'search tsx')).toBe('[Search]Palette.[tsx] 를 고침');
    expect(marked('배포해 배포', '배포 배포해')).toBe('[배포해] [배포]');
  });

  it('검색 문법 기호는 떼고, 없는 낱말은 안 칠한다', () => {
    expect(marked('배포 순서 정리', '"배포 순서"')).toBe('[배포] [순서] 정리');
    expect(marked('아무 말', '없음')).toBe('아무 말');
    expect(marked('아무 말', '   ')).toBe('아무 말');
  });
});

describe('searchExcerpt — 한 줄 밖의 낱말', () => {
  it('첫 일치가 앞 스무 글자 밖이면 그 앞에서 … 로 시작한다', () => {
    expect(searchExcerpt('짧은 배포 글', '배포')).toBe('짧은 배포 글');
    // 한 줄에 들어가는 글은 일치가 스무 글자 뒤여도 자르지 않는다(#1094 D1).
    expect(searchExcerpt('@task_manager 서버 최신버전 배포해', '배포')).toBe('@task_manager 서버 최신버전 배포해');
    // 자를 자리 앞뒤로 공백이 없으면 자르지 않는다.
    const noSpace = `${'가'.repeat(80)}배포`;
    expect(searchExcerpt(noSpace, '배포')).toBe(noSpace);
    const long = `${'가나다라 '.repeat(20)}여기서 배포했다`;
    const ex = searchExcerpt(long, '배포');
    expect(ex.startsWith('…')).toBe(true);
    expect(ex.endsWith('여기서 배포했다')).toBe(true);
    expect(ex.indexOf('배포')).toBeLessThanOrEqual(31);
    expect(ex.slice(1, 5)).toBe('가나다라');
    expect(searchExcerpt(long, '없는말')).toBe(long);
  });
});
