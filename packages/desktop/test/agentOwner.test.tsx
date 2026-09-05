import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Identity } from '../src/components/Identity';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

// #181: 소유자 표시는 `Identity` 한 곳에서만 나온다. `#146` 이 아이덴티티 표시를 공유
// 컴포넌트로 모았는데 `MessageItem` 이 따로 그리면 같은 사실이 세 곳에 살게 된다.
const fakeController = () => {
  const c = {
    toggleReaction: vi.fn(async () => undefined),
    openThread: vi.fn(async () => undefined),
    editMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
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
  it('소유자 표시는 Identity 배지 안에서만 나온다', () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'bot', 'u1') },
    });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'a1')} />);

    // 거터(variant=avatar)와 작성자 옆(variant=badge), 두 곳 다 Identity 를 통과한다.
    // **Task 12** 이후 거터는 사람과 같은 아바타라 "에이전트"라고 말하지 않는다 —
    // 그래서 이름줄 배지 하나만 남는다. 거터는 핸들로 찾는다.
    const badges = screen.getAllByText('에이전트').map((el) => el.parentElement!);
    expect(badges).toHaveLength(1);
    expect(screen.getByTestId('author-gutter').textContent).toContain('bot');
    // #277: 소유자 표시는 이름줄(badge)에서만 나온다. 거터(avatar)에는 안 나온다 —
    // 32px 고정폭 열이라 배지가 들어가면 넘쳤다. **표시가 틀렸던 게 아니라 자리가 틀렸다.**
    const shown = screen.getAllByText('@owner');
    expect(shown).toHaveLength(1);
    // 그 하나가 이름줄 배지 안에 있다. 개수만 세면 "거터에만 남은" 경우도 초록이다.
    const nameLineBadge = badges[0]!; // 이제 배지는 이름줄 하나뿐이다(Task 12).
    expect(nameLineBadge.contains(shown[0]!)).toBe(true);
    // 거터에는 없다 — 32px 열을 넘치기 때문이다(#277). 이제 거터에는 배지가 아니라
    // 아바타가 서므로 배지 배열이 아니라 **거터 자체**를 본다.
    expect(screen.getByTestId('author-gutter').textContent).not.toContain('@owner');
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
