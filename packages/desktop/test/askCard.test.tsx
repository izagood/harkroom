// Task 3 — 선택지 컴포넌트와 수신자 배지. 여기서 처음으로 경로가 관통한다.
//
// **이 파일이 지키는 것은 규칙 04다**: 강조는 `→ 나` 로 온 것에만 간다. 이 구별이 없으면
// 에이전트 셋이 도는 스레드는 상시 빨갛고, 빨강은 그 순간 신호이기를 멈춘다.
//
// 색 자체를 검사하지 않는다 — 클래스 문자열을 세면 스타일을 다듬는 순간 조용히 깨진다.
// 대신 `data-for-me` 로 **판정**을 고정하고, 누를 수 있는지(`disabled`)로 대접을 고정한다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { AskMeta, MessageRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

const ME = 'u-me';
const FORGE = 'a-forge';

const askMeta = (over: Partial<AskMeta['ask']> = {}): Record<string, unknown> => {
  const ask: AskMeta['ask'] = {
    options: [
      { id: 'new', label: '새 마이그레이션 009', hint: '되돌리기 쉽다' },
      { id: 'edit', label: '008 을 고친다' },
    ],
    to: { kind: 'human' },
    ...over,
  };
  return { kind: 'ask', ask } as unknown as Record<string, unknown>;
};

const askMessage = (meta: Record<string, unknown>): MessageRow =>
  msg('m-ask', 'c1', 1, '008 이 이미 배포됐는지 내가 모른다', FORGE, { meta });

let answerAsk: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useAppStore.getState().reset();
  answerAsk = vi.fn().mockResolvedValue(undefined);
  setController({ answerAsk } as unknown as Controller);
  useAppStore.getState().set({
    me: acc(ME, 'jaebin'),
    accounts: {
      [ME]: acc(ME, 'jaebin'),
      [FORGE]: acc(FORGE, 'forge', 'agent'),
    },
  });
});
afterEach(() => cleanup());

describe('AskCard — 수신자에 따른 두 얼굴', () => {
  it('나에게 온 선택지는 고를 수 있고, 클릭이 곧 답이다', () => {
    render(<MessageItem message={askMessage(askMeta())} />);

    const card = screen.getByTestId('ask-card');
    expect(card.dataset.forMe).toBe('true');
    // 배지가 "무엇이 내 일인가"를 말한다.
    expect(screen.getByTestId('audience-badge').dataset.forMe).toBe('true');
    expect(screen.getByText('골라 줘')).toBeTruthy();

    const option = screen.getByTestId('ask-option-new') as HTMLButtonElement;
    expect(option.disabled).toBe(false);
    // 판단 근거(hint)도 고르기 전에 읽혀야 한다.
    expect(screen.getByText('되돌리기 쉽다')).toBeTruthy();

    fireEvent.click(option);
    // 클릭 한 번이 답이다 — 사람이 다시 타이핑하지 않는다(규칙 05).
    expect(answerAsk).toHaveBeenCalledWith('m-ask', 'new', 'c1');
  });

  it('에이전트에게 간 선택지는 읽히되 누를 수 없다', () => {
    render(<MessageItem message={askMessage(askMeta({ to: { kind: 'account', accountId: FORGE } }))} />);

    const card = screen.getByTestId('ask-card');
    expect(card.dataset.forMe).toBe('false');
    // 누가 고르는지를 말한다 — 사람은 지켜만 본다.
    expect(screen.getByText('forge 가 고른다')).toBeTruthy();

    // **이 단언이 규칙 04의 실물이다**: 남의 선택은 진행을 막지만 나를 막지는 않는다.
    for (const id of ['new', 'edit']) {
      expect((screen.getByTestId(`ask-option-${id}`) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByTestId('ask-option-new'));
    expect(answerAsk).not.toHaveBeenCalled();

    // 배지는 남에게 갔음을 말하되 강조를 받지 않는다.
    expect(screen.getByTestId('audience-badge').dataset.forMe).toBe('false');
  });

  it('이미 답한 선택지는 고른 것만 남기고 다시 누를 수 없다', () => {
    render(<MessageItem message={askMessage(askMeta({
      answeredWith: 'new', answeredBy: ME, answeredAt: '2026-09-06T00:00:00.000Z',
    }))} />);

    const card = screen.getByTestId('ask-card');
    expect(card.dataset.answered).toBe('true');
    expect(screen.getByText('정해졌다')).toBeTruthy();
    expect(screen.getByText('jaebin 이(가) 골랐다')).toBeTruthy();

    // 고른 것만 남는다 — 안 고른 선택지를 계속 보이면 무엇으로 정해졌는지가 흐려진다.
    expect((screen.getByTestId('ask-option-new') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('ask-option-edit')).toBeNull();

    // 끝난 물음은 더 이상 아무도 기다리게 하지 않으므로 배지를 거둔다.
    expect(screen.queryByTestId('audience-badge')).toBeNull();

    fireEvent.click(screen.getByTestId('ask-option-new'));
    expect(answerAsk).not.toHaveBeenCalled();
  });
});

/**
 * **모르는 meta 는 평문으로 흘린다** — 이 계획 전 구간의 불변식이고, 구/신 버전 조합
 * (러너 × 서버 × 데스크탑)의 안전이 여기 달려 있다. 빈 상자는 "여기 뭔가 있다"는 거짓 신호다.
 */
describe('AskCard — 못 알아본 형식은 상자를 그리지 않는다', () => {
  it('meta 가 없거나 깨졌으면 카드도 배지도 없고 본문만 남는다', () => {
    for (const meta of [
      {},
      { kind: 'ask' },
      // 옵션이 하나면 선택이 아니다.
      { kind: 'ask', ask: { options: [{ id: 'a', label: 'A' }], to: { kind: 'human' } } },
      // 수신자를 못 읽으면 그리지 않는다 — '사람 아무나'로 넘기면 남의 물음이 강조된다.
      { kind: 'ask', ask: { options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } },
    ] as Record<string, unknown>[]) {
      cleanup();
      render(<MessageItem message={askMessage(meta)} />);
      expect(screen.queryByTestId('ask-card')).toBeNull();
      expect(screen.queryByTestId('audience-badge')).toBeNull();
      // 본문은 그대로 읽힌다 — 사라지지 않는다.
      expect(screen.getByText(/008 이 이미 배포됐는지/)).toBeTruthy();
    }
  });
});
