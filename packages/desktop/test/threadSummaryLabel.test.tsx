// 채널 요약 줄의 **접근 이름**에 상태가 실리는지(#484 1/3).
//
// ## 왜 이 회귀선이 따로 필요한가
//
// 뱃지는 화면에 **보이는데도** 스크린리더에는 없을 수 있다. 요약 버튼이 명시적
// `aria-label` 을 들고 있고, **`aria-label` 은 자식 글자를 통째로 덮어쓰기** 때문이다.
// 실제로 그 상태였다 — 접근성 트리에 `1 reply, last reply 오후 08:26` 만 있고 상태가
// 한 글자도 없었다(실측 2026-09-06, 띄운 앱의 트리에서 확인).
//
// 이 슬라이스가 만들려던 것이 **"열어야 하나"에 열지 않고 답하는 것**이므로, 그 답이
// 눈에만 있고 귀에는 없으면 절반은 미완성이다. 뱃지 렌더링 테스트로는 이 결함이 안
// 잡힌다 — 뱃지는 **정상적으로 그려지고 있었다.**
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

beforeEach(() => {
  setController({ openThread: vi.fn(async () => undefined) } as unknown as Controller);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
    messages: { c1: [] },
  });
});
afterEach(() => cleanup());

/** 서버가 실어 주는 집계(#484)를 얹은 요약 줄 하나. */
const summary = (over: Record<string, unknown>) => msg('m1', 'c1', 1, 'root', 'u2', {
  replyCount: 2,
  openAskHumanCount: 0,
  openAskAccountIds: [],
  failureCount: 0,
  lastKind: 'user',
  lastAuthorId: 'u2',
  ...over,
});

describe('요약 줄의 접근 이름', () => {
  it('내 차례가 이름에 실린다 — 뱃지가 보여도 라벨에 없으면 귀에는 없다', () => {
    render(<MessageItem message={summary({ openAskHumanCount: 1 })} />);
    const btn = screen.getByRole('button', { name: /내 차례/ });
    // 답장 수도 그대로 남는다 — 상태가 그것을 **대체**하는 것이 아니라 앞에 선다.
    expect(btn.getAttribute('aria-label')).toContain('2 replies');
  });

  it('막힘도 마찬가지다', () => {
    render(<MessageItem message={summary({ failureCount: 1 })} />);
    expect(screen.getByRole('button', { name: /막힘/ })).toBeTruthy();
  });

  /**
   * **모르면 아무 말도 하지 않는다.** 집계가 없는 자리(옛 서버·답글 행)는 판정 자체가
   * `null` 이므로 라벨도 예전 그대로여야 한다 — 없는 상태를 지어내지 않는다.
   */
  it('집계가 없으면 상태를 지어내지 않는다', () => {
    render(<MessageItem message={summary({ openAskHumanCount: null, openAskAccountIds: null, failureCount: null })} />);
    const btn = screen.getByRole('button', { name: /2 replies/ });
    const label = btn.getAttribute('aria-label') ?? '';
    for (const word of ['내 차례', '막힘', '남을 기다림', '도는 중', '끝남']) {
      expect(label).not.toContain(word);
    }
  });
});
