import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Identity } from '../src/components/Identity';
import { MessageItem } from '../src/components/MessageItem';
import { Directory } from '../src/components/Directory';
import { Composer } from '../src/components/Composer';
import { acc, msg } from './helpers/fakeApi';

// #181: 소유자 표시는 `Identity` 한 곳에서만 나온다. `#146` 이 아이덴티티 표시를 공유
// 컴포넌트로 모았는데 호출자가 따로 그리면 같은 사실이 세 곳에 살게 된다.
const fakeController = () => {
  const c = {
    toggleReaction: vi.fn(async () => undefined),
    openThread: vi.fn(async () => undefined),
    editMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    // 디렉터리·컴포저가 마운트되며 부른다 — 없으면 렌더 도중 터진다.
    refreshAccounts: vi.fn(async () => undefined),
    typing: vi.fn(),
    upload: vi.fn(),
  };
  setController(c as unknown as Controller);
  return c;
};

const agent = (id: string, handle: string, ownerAccountId: string | null) =>
  ({ ...acc(id, handle, 'agent'), ownerAccountId });

beforeEach(() => {
  useAppStore.getState().reset();
});
afterEach(() => cleanup());

describe('#181 에이전트 소유자 표시', () => {
  /**
   * 초판은 이 사실을 **메시지 화면**에서 쟀다: "거터에는 없고 이름줄 배지 안에 있다".
   * 근거는 #277 이었다 — 소유자 표시가 틀린 게 아니라 **자리**가 틀렸으니 32px 거터에서
   * 빼고 이름 옆으로 옮긴다.
   *
   * **identity 문서로 뒤집혔다.** 메시지 대화 화면에서는 이름 옆 배지도 뺐다 — 아바타가
   * 사람과 같아진 뒤(#465)로 🤖 는 중복이고, 종류·소유자는 프로필(#475)이 답한다.
   *
   * 그러나 **#181 이 지키는 사실 자체는 무효가 되지 않았다.** "이 에이전트는 누구 것인가"
   * 는 여전히 화면이 답해야 하는 물음이고, 답하는 자리가 대화 화면에서 **디렉터리와
   * 자동완성**으로 옮겨 갔을 뿐이다("누가 있나 / 누구 것인가"·"누구의 에이전트를 부르는가").
   * 그래서 같은 사실을 그 두 자리에서 계속 잰다 — 무효가 된 것은 **측정 장소**뿐이다.
   *
   * 두 화면을 한 파일에서 함께 보는 이유는 초판과 같다: 한 자리만 재면 다른 자리를
   * 없애도 초록이고, #181 은 "소유자를 볼 수 있다"이지 "디렉터리에서 볼 수 있다"가 아니다.
   */
  it('소유자 표시는 디렉터리와 자동완성 후보의 Identity 배지에서 나온다', async () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'bot', 'u1') },
    });
    fakeController();

    render(<Directory open onClose={vi.fn()} />);
    const agents = await screen.findByRole('region', { name: 'Agents' });
    // 소유자는 에이전트 행의 배지 **안**에서 나온다. 행만 보면 디렉터리가 소유자를
    // 자기 손으로 그려도 초록이다 — 배지를 짚어 `Identity` 를 통과했음을 못 박는다.
    const badge = within(agents).getByText('에이전트').parentElement!;
    expect(badge.textContent).toContain('@owner');
    cleanup();

    // 자동완성 후보에서도 같은 사실이 나온다 — 부르기 직전이 "누구의 에이전트인가"가
    // 가장 필요한 순간이다.
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@bot' } });
    expect(screen.getByRole('option', { name: /bot/ }).textContent).toContain('@owner');
  });

  /**
   * **대화 화면에서는 소유자를 말하지 않는다**(identity 문서). 위 회귀선의 거울상이고,
   * 둘이 함께 있어야 "옮겼다"가 "지웠다"나 "안 옮겼다"와 구분된다.
   *
   * #277 의 거터 단언이 여기 남는다 — 소유자가 32px 열로 되돌아가는 것을 막는 선은
   * 배지를 이름줄에서 뺐다고 사라지지 않는다(`gutterOverflowRegression.test.tsx` 도 잰다).
   */
  it('메시지 행에서는 종류도 소유자도 말하지 않는다', () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'bot', 'u1') },
    });
    fakeController();
    const { container } = render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'a1')} />);

    expect(screen.queryByText('에이전트')).toBeNull();
    expect(container.textContent).not.toContain('@owner');
    expect(screen.getByTestId('author-gutter').textContent).not.toContain('@owner');
    // 거터는 **누구인지는 말한다** — 없앤 것이 아니라 종류·소유자만 뺀 것이다.
    expect(screen.getByTestId('author-gutter').textContent).toContain('bot');
  });

  it('Identity 를 단독으로 그려도 같은 표시가 나온다', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'owner') } });
    render(<Identity account={agent('a1', 'bot', 'u1')} />);
    expect(screen.getByText('@owner')).toBeTruthy();
    // 이모지 옆 가운뎃점은 장식이라 스크린리더에는 "소유자"가 간다.
    expect(screen.getByText('소유자')).toBeTruthy();
  });

  it('소유자 id 가 디렉터리에 없으면 아무것도 그리지 않는다', () => {
    // 소유자 계정이 지워진 뒤 디렉터리가 아직 갱신되지 않은 창이다. "모른다"를 "없다"로
    // 단정하지 않고, 소유자 자리를 비워 둔다.
    useAppStore.getState().set({ accounts: { a1: agent('a1', 'bot', 'gone') } });
    render(<Identity account={agent('a1', 'bot', 'gone')} />);
    const badge = screen.getByText('에이전트').parentElement!;
    // 부분 문자열로 본다 — "소유자 없음" 같은 문구가 들어오는 것까지 막아야 한다.
    // 문구를 넣으면 화면 대부분이 그것으로 채워져 아무것도 구분하지 못한다.
    expect(badge.textContent).not.toContain('소유자');
  });

  it('사람 계정에는 소유자 자리를 만들지 않는다', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'owner') } });
    const { container } = render(<Identity account={{ ...acc('u2', 'alice'), ownerAccountId: 'u1' }} />);
    // 사람 계정에 소유자 값이 실려 와도 그리지 않는다 — 소유자 개념은 에이전트에만 있다.
    expect(screen.queryByText('@owner')).toBeNull();
    expect(container.textContent).not.toContain('소유자');
  });
});
