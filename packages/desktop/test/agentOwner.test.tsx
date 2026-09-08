import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { Identity } from '../src/components/Identity';
import { MessageItem } from '../src/components/MessageItem';
import { Directory } from '../src/components/Directory';
import { Composer } from '../src/components/Composer';
import { Profile } from '../src/components/Profile';
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

// **언어를 한국어로 고정한다.** 이 파일의 축들은 이 화면의 한국어 문구로 쓰여 있고,
// 그 문구가 지키는 것은 언어가 아니라 **그 언어로 표현된 규율**이다(`#619`·사이드바 PR 이
// 세운 방식과 같다). 영어가 원본이라 기본값이 영어이므로, 한국어를 재려면 한국어라고
// 말해야 한다. 두 언어로 다 뜨는지는 `i18n.test.tsx` 가 잰다.
beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
});
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('#181 에이전트 소유자 표시', () => {
  /**
   * 이 회귀선은 **두 번 뒤집혔다**. 초판은 메시지 화면에서 쟀고(거터가 아니라 이름 옆 배지,
   * #277), 다음 판은 대화에서 배지를 뺀 뒤 같은 사실을 **디렉터리와 자동완성**에서 쟀다.
   *
   * 이제 그 두 자리에서도 뺀다: **화면은 계정이 사람인지 에이전트인지 말하지 않는다**
   * (design doc 2, #455). 소유자 핸들은 종류를 말하는 것과 같다 — 사람 행에는 없는 자리가
   * 에이전트 행에만 붙으면, 아바타를 같게 만들어 지운 구분이 그 자리로 되돌아온다.
   *
   * **#181 이 지키는 사실은 여전히 무효가 아니다.** "이 에이전트는 누구 것인가"는 화면이
   * 답해야 하는 물음이고, 답하는 자리가 프로필(#475)로 옮겨 갔을 뿐이다 — `profile.test.tsx`
   * 가 그 자리를 잰다. 여기서는 **옮겼다**를 못 박는다: 목록에는 없고, 프로필에는 있다.
   * 한쪽만 재면 "옮겼다"가 "지웠다"와 구분되지 않는다.
   */
  it('소유자는 디렉터리에도 자동완성 후보에도 나오지 않는다', async () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'bot', 'u1') },
    });
    fakeController();

    render(<Directory open onClose={vi.fn()} />);
    const agents = await screen.findByRole('region', { name: 'Agents' });
    expect(agents.textContent).not.toContain('@owner');
    // 🤖 도 같이 나간다 — 소유자만 지우고 글리프를 남기면 "이건 에이전트다"를 계속 말한다.
    expect(agents.textContent).not.toContain('🤖');
    cleanup();

    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@bot' } });
    const option = screen.getByRole('option', { name: /bot/ });
    expect(option.textContent).not.toContain('@owner');
    expect(option.textContent).not.toContain('🤖');
  });

  // 옮겨 간 자리. 이것이 없으면 위 회귀선은 "지웠다"도 통과시킨다.
  it('소유자는 프로필에서 답한다', () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'bot', 'u1') },
    });
    setController({ listAgents: vi.fn(async () => []), startDm: vi.fn(async () => undefined) } as unknown as Controller);
    render(<Profile accountId="a1" onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('소유자');
    expect(dialog.textContent).toContain('@owner');
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

  it('Identity 를 단독으로 그려도 소유자를 내지 않는다 — variant 를 가리지 않는다', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'owner') } });
    // 소유자를 낼 수 있는 variant 가 아예 없다. 배지 자리(기본값)는 아무것도 그리지 않고,
    // 아바타 자리는 이름 첫 글자다 — 호출자가 variant 를 어떻게 주든 소유자는 안 나온다.
    const bad = render(<Identity account={agent('a1', 'bot', 'u1')} />);
    expect(bad.container.textContent).toBe('');
    cleanup();

    const av = render(<Identity account={agent('a1', 'bot', 'u1')} variant="avatar" />);
    expect(av.container.textContent).not.toContain('@owner');
    expect(av.container.textContent).not.toContain('소유자');
  });

  it('사람과 에이전트가 같은 마크업으로 선다 — 소유자 값이 실려 와도 다르지 않다', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'owner') } });
    // 사람 계정에 소유자 값이 실려 와도 그리지 않는다 — 소유자 개념은 에이전트에만 있다.
    // 그리고 이제 에이전트 쪽도 같다: 두 행이 같은 모양이어야 "구분하지 않는다"가 된다.
    const person = render(<Identity account={{ ...acc('u2', 'alice'), ownerAccountId: 'u1' }} variant="avatar" />);
    const personHtml = person.container.innerHTML.replaceAll('alice', 'X').replaceAll('A', 'X');
    cleanup();

    const bot = render(<Identity account={agent('u2', 'alice', 'u1')} variant="avatar" />);
    expect(bot.container.innerHTML.replaceAll('alice', 'X').replaceAll('A', 'X')).toBe(personHtml);
    expect(bot.container.textContent).not.toContain('@owner');
  });
});
