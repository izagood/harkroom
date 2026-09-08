/**
 * 붙여넣기가 부르는 이름 · 인용 변환(2단계).
 *
 * 이 파일이 지키는 계약은 하나다: **인용으로 바꾼 글은 아무도 부르지 않는다.** 그것을
 * 서버가 쓰는 판정(`mentionedHandles`)으로 직접 확인한다 — 화면이 "부르지 않는다"고
 * 적어 놓고 실제로는 부르는 것이 이 기능에서 가장 나쁜 실패다.
 */
import { describe, it, expect } from 'vitest';
import { QUOTE_LINE, mentionedHandles } from '@murmur/shared';
import { callsInText, quoteText, MANY_CALLS } from '../src/lib/pasteCalls';

const known = new Set(['murmur', 'patch', 'docs', 'team-desk']);

describe('부르는 이름 세기 — 서버와 같은 판정이다', () => {
  it('아는 이름만 센다 — 오타는 서버도 부르지 않는다', () => {
    expect(callsInText('@murmur @nope 확인 부탁', known).sort()).toEqual(['murmur']);
  });

  it('코드 블록과 인용 줄 안의 이름은 세지 않는다', () => {
    const body = ['> @murmur 라고 적혀 있었다', '```', '@patch', '```', '@docs 확인'].join('\n');
    expect(callsInText(body, known)).toEqual(['docs']);
  });

  it('그룹·팀 handle 도 부르는 이름이다 — 다만 사람 수는 서버만 안다', () => {
    expect(callsInText('@team-desk 봐 주세요', known)).toEqual(['team-desk']);
  });
});

describe('인용 변환 — 이것이 폭주를 끊는 수단이다', () => {
  it('인용으로 바꾸면 아무도 부르지 않는다', () => {
    const pasted = '@murmur 스레드로 묶는 쪽이 낫다\n\n— @patch @docs 의견 반영';
    expect(callsInText(pasted, known)).toHaveLength(3);
    expect(mentionedHandles(quoteText(pasted))).toHaveLength(0);
  });

  it('모든 줄이 렌더러·파서가 인용이라고 부르는 모양이 된다', () => {
    for (const line of quoteText('첫 줄\n\n둘째 줄').split('\n')) {
      expect(QUOTE_LINE.test(line)).toBe(true);
    }
  });

  it('빈 줄도 `>` 를 받는다 — 비워 두면 인용이 여러 덩이로 쪼개진다', () => {
    expect(quoteText('a\n\nb')).toBe('> a\n>\n> b');
  });

  it('이미 인용인 줄에 두 번 붙이지 않는다', () => {
    expect(quoteText('> 이미 인용\n평문')).toBe('> 이미 인용\n> 평문');
  });

  it('원문의 글자를 잃지 않는다 — 표시만 붙는다', () => {
    const src = '@murmur 확인\n두 번째 줄';
    expect(quoteText(src).split('\n').map((l) => l.replace(QUOTE_LINE, '$1')).join('\n')).toBe(src);
  });
});

describe('확인 문턱', () => {
  it('셋부터 묻는다 — 둘까지는 사람이 의도해서 부르는 일이 흔하다', () => {
    expect(MANY_CALLS).toBe(3);
  });
});
