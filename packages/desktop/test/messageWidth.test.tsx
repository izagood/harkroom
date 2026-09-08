// 본문 열의 폭 — **남는 자리를 쓰되, 무한히 늘리지는 않는다.**
//
// 앞 판은 `max-w-[70ch]` 였다. 뿌리 글자 13px 에서 약 500px 이라, 스레드를 열지 않고
// 채널만 보는 사람에게는 1300px 짜리 창에서도 글이 화면 한가운데서 끊기고 오른쪽이
// 통째로 비었다(2026-09-08 신고). 고친 판은 상한만 남기고 자라는 일을 `flex-1` 에
// 맡긴다 — 좁으면 창 폭, 넓으면 상한까지.
//
// jsdom 에는 레이아웃이 없다 — 픽셀로 재지 못한다. 그래서 **계약을 DOM 으로** 단언한다:
// (1) 열이 자라는가(`flex-1`), (2) 상한이 `ch` 가 아니라 px 인가 — `ch` 는 글자 크기에
// 묶여 있어 "화면이 넓으면 넓게"를 표현할 수 없는 단위이고 그것이 이번 결함의 원인이었다,
// (3) 그 상한이 *너무 좁지도(다시 가운데서 끊긴다) 너무 넓지도(4K 를 가로지른다)* 않은가.
//
// 폭 상한은 **한 곳**이라는 것도 여기서 지킨다: 보고·물음·실패 카드가 자기 상한
// (`max-w-prose`)을 다시 갖게 되면, 열을 넓혀도 카드만 옛 폭으로 남아 화면에 두 개의
// 답이 선다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

const ME = 'u-me';
const BOT = 'a-bot';

/** 상한의 허용 범위. 값 자체(1280px)를 박지 않는 이유는 이 파일이 지키는 것이 숫자가
 *  아니라 **"넓게 쓰되 끝없이는 아니다"** 라는 결정이기 때문이다. 아래 두 끝은 그 결정이
 *  깨지는 지점이다: 900px 아래면 넓은 창에서 다시 가운데서 끊기고, 2000px 위면 4K 에서
 *  한 줄이 화면을 가로지른다. */
const MIN_CAP_PX = 900;
const MAX_CAP_PX = 2000;

const column = () => screen.getByTestId('message-body-column');

const renderMessage = (meta: Record<string, unknown> = {}) => {
  useAppStore.getState().set({
    me: acc(ME, 'jaebin'),
    accounts: { [ME]: acc(ME, 'jaebin'), [BOT]: acc(BOT, 'bot', 'agent') },
  });
  setController({ toggleReaction: vi.fn(), openThread: vi.fn() } as unknown as Controller);
  return render(<MessageItem message={msg('m1', 'c1', 1, '긴 보고문이 여기 산다', BOT, { meta })} />);
};

beforeEach(() => useAppStore.getState().reset());
afterEach(() => cleanup());

describe('본문 열의 폭', () => {
  it('남는 자리를 채운다 — 열이 자라고, 긴 URL 이 열을 밀어내지 못한다', () => {
    renderMessage();
    const box = column();
    expect(box.classList.contains('flex-1')).toBe(true);
    // `min-w-0` 은 폭 상한과 다른 계약이다(긴 코드·URL 이 flex 열을 밀어내는 것을 막는다).
    // 상한을 손보다 함께 지워지기 쉬워서 같은 자리에서 잰다.
    expect(box.classList.contains('min-w-0')).toBe(true);
  });

  it('상한은 글자 크기(ch)가 아니라 픽셀이다', () => {
    renderMessage();
    const classes = [...column().classList];
    // 회귀: `max-w-[70ch]`. `ch` 상한은 창이 아무리 넓어도 같은 폭에서 끊는다.
    expect(classes.filter((c) => /^max-w-\[\d+(\.\d+)?ch\]$/.test(c))).toEqual([]);
    expect(classes.some((c) => /^max-w-\[\d+px\]$/.test(c))).toBe(true);
  });

  it('상한이 있고, 너무 좁지도 너무 넓지도 않다', () => {
    renderMessage();
    const cap = [...column().classList]
      .map((c) => /^max-w-\[(\d+)px\]$/.exec(c)?.[1])
      .find((v) => v != null);
    expect(cap).toBeDefined();
    expect(Number(cap)).toBeGreaterThanOrEqual(MIN_CAP_PX);
    expect(Number(cap)).toBeLessThanOrEqual(MAX_CAP_PX);
  });
});

describe('카드는 자기 폭 상한을 갖지 않는다', () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['report-card', '보고', { kind: 'report', report: { checks: ['테스트 통과'] } }],
    ['failure-card', '실패', { kind: 'failure', failure: { retryable: true, reason: '막혔다' } }],
    ['ask-card', '물음', {
      kind: 'ask',
      ask: { options: [{ id: 'a', label: '가' }, { id: 'b', label: '나' }], to: { kind: 'human' } },
    }],
  ];

  for (const [testid, name, meta] of cases) {
    it(`${name} 카드는 열을 그대로 채운다`, () => {
      renderMessage(meta);
      const card = screen.getByTestId(testid);
      // `max-w-prose` 는 65ch — 열을 넓혀도 카드만 옛 폭에 남는다.
      expect(card.classList.contains('max-w-prose')).toBe(false);
      expect([...card.classList].filter((c) => c.startsWith('max-w-'))).toEqual([]);
    });
  }
});
