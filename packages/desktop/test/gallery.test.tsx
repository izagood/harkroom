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

  /**
   * **어휘는 계정 목록에 매달리지 않는다**(v0.1.52 실측 회귀).
   *
   * 앞 판본은 에이전트 수에 따라 갤러리가 다른 말을 했다. 실측:
   *
   * ```
   * 0개  세 카드가 전부 `for-me=true` — 규칙 04 를 가르치는 칸이 규칙을 위반했다
   *      두 사슬이 전부 `end=me` — 교착 칸이 교착을 안 그렸다
   *      두 줄이 `jaebin 가 사람의 답을 기다린다` — 내가 나를 기다리는 문장
   * 1개  교착이 `forge 가 서로를 기다린다` — 혼자 교착하는 문장
   * ```
   *
   * 갤러리는 다른 화면을 재는 **기준자**다. 기준자가 계정 목록에 따라 흔들리면 그것으로
   * 잰 판정이 전부 흔들리므로, **에이전트 수와 무관하게** 어휘가 같은지를 잰다.
   *
   * 색·강조 쪽 단정은 `accentBudget.test.tsx` 에 있다(강조 예산이 그 파일의 주제다).
   * 여기서는 **모양**을 잰다: 수신자가 갈리는가, 사슬이 둘로 갈리는가.
   */
  describe('어휘가 에이전트 수에 흔들리지 않는다', () => {
    const counts = [
      ['없음', {}],
      ['하나', { [A1]: acc(A1, 'forge', 'agent', false, { ownerAccountId: ME }) }],
      ['둘', {
        [A1]: acc(A1, 'forge', 'agent', false, { ownerAccountId: ME }),
        [A2]: acc(A2, 'codex', 'agent'),
      }],
    ] as const;

    for (const [label, accounts] of counts) {
      it(`에이전트 ${label} — 수신자와 사슬이 규칙대로 갈린다`, () => {
        useAppStore.getState().set({ accounts: { [ME]: acc(ME, 'jaebin'), ...accounts } });
        render(<GallerySettings />);

        // 규칙 04: 나에게 온 것 · **남에게 간 것** · 이미 답한 것.
        expect(screen.getAllByTestId('ask-card').map((c) => c.dataset.forMe))
          .toEqual(['true', 'false', 'true']);
        // 두 사슬이 서로 다른 끝을 그린다 — 둘이 같으면 한 칸이 자기 설명과 어긋난다.
        expect(screen.getAllByTestId('wait-chain').map((c) => c.dataset.end))
          .toEqual(['me', 'deadlock']);
        // 교착의 종류도 갈린다: 서로를 기다리는 것과 죽은 러너는 사람이 할 일이 다르다.
        expect(screen.getAllByTestId('wait-chain')[1]!.dataset.reason).toBe('cycle');
      });
    }

    /**
     * **내 차례 사슬은 두 마디여야 한다** — 그것이 이 칸의 요점("몇 개가 풀리는지가
     * 사람이 답할 이유다")이다. 앞 판본은 에이전트가 없을 때 두 마디가 같은 계정(나)으로
     * 접혀 한 마디가 됐고, 그러면 `— 답하면 N개가 풀린다` 가 아예 사라졌다(실측).
     */
    it('내 차례 사슬은 두 마디가 이어진다 — 풀리는 수를 말할 수 있어야 한다', () => {
      useAppStore.getState().set({ accounts: { [ME]: acc(ME, 'jaebin') } });
      render(<GallerySettings />);
      expect(screen.getAllByTestId('wait-chain')[0]!.dataset.unblocks).toBe('2');
    });

    /**
     * **내가 낸 말로 바뀌지 않는다.** 앞 판본의 `authorId: a2?.id ?? myId` 는 에이전트가
     * 없을 때 "에이전트가 말한 것"을 "내가 말한 것"으로 바꿨다 — 그러면 에이전트끼리의
     * 주고받기 칸이 나 혼자 떠드는 줄이 되고, 그 칸이 가르치는 것이 거짓이 된다.
     */
    it('에이전트가 없어도 갤러리가 나를 화자로 만들지 않는다', () => {
      useAppStore.getState().set({ accounts: { [ME]: acc(ME, 'jaebin') } });
      render(<GallerySettings />);
      // 사슬 줄에 내 이름이 없다 — 이름을 모르면 `…` 이고, 그것이 이 저장소의 규약이다.
      for (const chain of screen.getAllByTestId('wait-chain')) {
        expect(chain.textContent).not.toContain('jaebin');
      }
    });
  });

  it('에이전트가 둘 미만이면 이름이 빈다고 말한다 — 색이 아니라 이름만', () => {
    useAppStore.getState().set({ accounts: { [ME]: acc(ME, 'jaebin') } });
    render(<GallerySettings />);
    expect(screen.getByText(/이름 자리가/)).toBeTruthy();
    // 그래도 화면 자체는 선다 — 빈 화면이면 무엇이 잘못됐는지 알 수 없다.
    expect(screen.getByTestId('gallery')).toBeTruthy();
  });
});
