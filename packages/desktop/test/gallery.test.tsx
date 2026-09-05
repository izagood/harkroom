// Task 11 — 컴포넌트 갤러리.
//
// **여기가 깨지면 어휘가 깨진 것이다.** 갤러리는 목업이 아니라 진짜 컴포넌트에 진짜 `meta` 를
// 넣어 그리므로, 이 스모크 테스트 하나가 여덟 가지 말이 전부 렌더된다는 것을 지킨다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { GallerySettings } from '../src/components/settings/GallerySettings';
import { SETTINGS_GROUPS } from '../src/components/settings/sections';
import { acc } from './helpers/fakeApi';

const ME = 'u-me';
const A1 = 'a-forge';
const A2 = 'a-codex';

beforeEach(() => {
  useAppStore.getState().reset();
  setController({} as unknown as Controller);
  useAppStore.getState().set({
    me: acc(ME, 'jaebin'),
    accounts: {
      [ME]: acc(ME, 'jaebin'),
      [A1]: acc(A1, 'forge', 'agent', false, { ownerAccountId: ME }),
      [A2]: acc(A2, 'codex', 'agent'),
    },
  });
});
afterEach(() => cleanup());

describe('컴포넌트 갤러리', () => {
  it('목차의 맨 끝에 선다 — 개발자용이라 찾아 들어갈 일이 없는 자리다', () => {
    const app = SETTINGS_GROUPS.find((g) => g.title === 'App')!;
    expect(app.items[app.items.length - 1]!.id).toBe('gallery');
  });

  /**
   * **여덟 가지 말이 전부 그려진다.** 하나라도 빠지면 그 어휘가 깨졌거나 갤러리가
   * 따라오지 못한 것이고, 둘 다 고쳐야 하는 상태다.
   */
  it('어휘가 전부 렌더된다', () => {
    render(<GallerySettings />);
    expect(screen.getByTestId('gallery')).toBeTruthy();

    // 선택 — 세 상태(나에게 / 남에게 / 답한 것)
    expect(screen.getAllByTestId('ask-card')).toHaveLength(3);
    // 실패 — retryable 둘
    expect(screen.getAllByTestId('failure-card')).toHaveLength(2);
    expect(screen.getByTestId('report-card')).toBeTruthy();
    expect(screen.getByTestId('progress-row')).toBeTruthy();
    expect(screen.getByTestId('agent-exchange')).toBeTruthy();
    expect(screen.getByTestId('thread-participants')).toBeTruthy();
    // 상태 5단이 모두 선다.
    expect(screen.getAllByTestId('thread-state')).toHaveLength(5);
    // 대기 사슬 — 내 차례와 교착 둘
    expect(screen.getAllByTestId('wait-chain')).toHaveLength(2);
  });

  it('두 얼굴이 실제로 갈린다 — 갤러리가 규칙 04 를 보여 준다', () => {
    render(<GallerySettings />);
    const cards = screen.getAllByTestId('ask-card');
    // 나에게 온 것 · 남에게 간 것 · 이미 답한 것.
    expect(cards.map((c) => c.dataset.forMe)).toEqual(['true', 'false', 'true']);
    expect(cards.map((c) => c.dataset.answered)).toEqual(['false', 'false', 'true']);
  });

  it('교착과 내 차례가 다른 줄로 그려진다', () => {
    render(<GallerySettings />);
    const chains = screen.getAllByTestId('wait-chain');
    expect(chains.map((c) => c.dataset.end)).toEqual(['me', 'deadlock']);
  });

  it('실패는 retryable 로 갈린다 — 없는 문은 그리지 않는다', () => {
    render(<GallerySettings />);
    expect(screen.getAllByTestId('failure-card').map((c) => c.dataset.retryable))
      .toEqual(['true', 'false']);
    // 다시 부르기는 retryable 인 하나에만 있다.
    expect(screen.getAllByTestId('failure-retry')).toHaveLength(1);
  });

  it('에이전트가 없어도 깨지지 않는다 — 이름을 못 채운다고 말한다', () => {
    useAppStore.getState().set({ accounts: { [ME]: acc(ME, 'jaebin') } });
    render(<GallerySettings />);
    expect(screen.getByText(/에이전트가 하나도 없어/)).toBeTruthy();
    // 그래도 화면 자체는 선다 — 빈 화면이면 무엇이 잘못됐는지 알 수 없다.
    expect(screen.getByTestId('gallery')).toBeTruthy();
  });
});
