import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { ThreadPanel } from '../src/components/ThreadPanel';
import { Identity, resetAvatarCache } from '../src/components/Identity';
import { acc, msg } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';

// #277: 에이전트 메시지의 소유자 @핸들이 아바타 거터를 넘친다.
// `Identity` 가 거터(고정폭 열)와 이름 옆(인라인) 두 자리를 겸했고, 이름 옆에 맞춘
// 배지(`🤖 · @소유자`)가 32px 열에 들어가 넘쳤다. `variant` 로 자리를 명시해 가른다.
//
// jsdom 에는 레이아웃이 없다 — 넘침을 픽셀로 재지 못한다. 그래서 **넘칠 수 있는 내용이
// 거터에 들어갔는가**(소유자 핸들 텍스트)와 **넘침을 막는 계약이 걸려 있는가**
// (`overflow-hidden`, `flex-wrap` 없음)를 DOM 으로 단언한다.

const fakeController = () => {
  const c = {
    toggleReaction: vi.fn(async () => undefined),
    openThread: vi.fn(async () => undefined),
    closeThread: vi.fn(),
    reply: vi.fn(async () => undefined),
    editMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
    fetchAvatar: vi.fn(async () => new Blob(['x'], { type: 'image/png' })),
  };
  setController(c as unknown as Controller);
  return c;
};

const agent = (id: string, handle: string, ownerAccountId: string | null) =>
  ({ ...acc(id, handle, 'agent'), ownerAccountId });

/** 거터는 클래스 문자열이 아니라 testid 로 찾는다 — 스타일을 손봐도 계속 같은 것을 지킨다. */
const gutter = () => screen.getByTestId('author-gutter');
/** 거터 안의 `Identity` 최상단 span. */
const gutterIdentity = () => gutter().firstElementChild as HTMLElement;

beforeEach(() => {
  useAppStore.getState().reset();
  resetAvatarCache();
});
afterEach(() => cleanup());

describe('#277 에이전트 거터 넘침 방지', () => {
  // 회귀 1: 에이전트 작성자의 거터에 소유자 핸들 텍스트가 없다.
  it('에이전트 거터에 소유자 핸들이 없다', () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'bot', 'u1') },
    });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'a1')} />);

    // 거터 **전체**를 본다 — 글리프의 부모만 보면 배지가 거터의 다른 자리로 옮겨 가도 초록이다.
    expect(gutter().textContent).not.toContain('@owner');
    expect(gutter().textContent).not.toContain('·');
    // 봇 글리프 자체는 남는다 — 없애는 것이 아니라 소유자만 뺀 것이다.
    expect(within(gutter()).getByText('🤖')).toBeTruthy();
  });

  // 회귀 2: 사람 작성자의 거터는 지금과 같다(둥근 아바타, 이미지 있으면 이미지).
  //
  // **이 보증은 variant 를 뒤집어도 빨개지지 않는다** — 사람 쪽은 두 variant 에서 같은
  // 마크업이어야 하는 것이 요점이기 때문이다(#277 이 고치는 것은 에이전트 쪽뿐이다).
  // 그래서 이 테스트가 지키는 것은 "사람 아바타를 건드리지 않았는가"이고, 사람 분기의
  // 클래스를 실제로 바꾸면 빨개진다(`rounded-full` → `rounded` 로 리터럴 주입해 확인).
  it('사람 거터는 둥근 아바타가 그대로다', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'alice') } });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u1')} />);

    const box = gutterIdentity();
    // 둥근 아바타다 — 모서리만 둥근 사각(`rounded`)이 아니라 원(`rounded-full`)이다.
    expect(box.classList.contains('rounded-full')).toBe(true);
    expect(box.classList.contains('rounded')).toBe(false);
    // 이니셜 폴백과 접근성 이름(핸들)도 그대로.
    expect(within(box).getByText('A')).toBeTruthy();
    expect(within(box).getByText('alice')).toBeTruthy();
    // 사진이 상자를 넘지 않는 계약은 사람 쪽에도 걸려 있다(#159 로 사진이 들어온다).
    expect(box.classList.contains('overflow-hidden')).toBe(true);
  });

  it('사람 거터에 사진이 있으면 사진이 그대로 나온다', async () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'alice', 'human', false, { avatarAttachmentId: 'att-1' }) },
    });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u1')} />);

    const img = await within(gutter()).findByTestId('identity-avatar');
    expect(img.getAttribute('src')).toMatch(/^blob:/);
  });

  // 회귀 3: 이름 옆 배지에는 여전히 @소유자가 있다(#181 유지).
  it('이름 옆 배지에 소유자 핸들이 있다', () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'bot', 'u1') },
    });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'a1')} />);

    // 소유자는 화면에 정확히 한 번 — 거터에서 빠졌고 이름줄에는 남았다.
    const shown = screen.getAllByText('@owner');
    expect(shown).toHaveLength(1);
    // 그 하나가 거터 **밖**에 있다. 개수만 세면 "거터에만 남고 이름줄에서 사라진" 경우도 초록이다.
    expect(gutter().contains(shown[0]!)).toBe(false);
  });

  // 회귀 4: 거터 요소에 overflow-hidden 이 있고 flex-wrap 이 없다.
  it('거터 Identity 에 overflow-hidden 이 있고 flex-wrap 이 없다', () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'bot', 'u1') },
    });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'a1')} />);

    const box = gutterIdentity();
    expect(box.classList.contains('overflow-hidden')).toBe(true);
    // `flex-wrap` 이 있으면 내용이 두 줄로 접히며 32px 열의 높이를 밀어낸다.
    expect(box.classList.contains('flex-wrap')).toBe(false);
  });

  // 회귀 5: 스레드 패널의 에이전트 답변 거터도 1 과 같다.
  //
  // `MessageItem` 을 직접 그리지 않고 **`ThreadPanel` 을 마운트한다** — 직접 그리면
  // 회귀 1 과 같은 경로를 두 번 재는 셈이고, 스레드 패널이 자기 아바타를 따로 그리기
  // 시작해도 초록으로 남는다.
  it('스레드 패널의 에이전트 답변 거터에도 소유자 핸들이 없다', () => {
    undoSendStorage.saveWindowMs(0);
    useAppStore.getState().set({
      me: acc('u1', 'owner'),
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'bot', 'u1') },
      activeChannelId: 'c1',
      threadRootId: 'm1',
      messages: {
        c1: [
          msg('m1', 'c1', 1, '질문', 'u1'),
          msg('m2', 'c1', 2, '답변', 'a1', { threadRootId: 'm1' }),
        ],
      },
    });
    fakeController();
    render(<ThreadPanel />);

    // 답변(에이전트)의 거터를 고른다 — 루트는 사람이라 거터가 둘이다.
    const gutters = screen.getAllByTestId('author-gutter');
    const agentGutters = gutters.filter((g) => g.textContent?.includes('🤖'));
    expect(agentGutters).toHaveLength(1);
    expect(agentGutters[0]!.textContent).not.toContain('@owner');
    // 소유자는 스레드 안에서도 이름줄에는 남아 있다(#181).
    expect(screen.getAllByText('@owner')).toHaveLength(1);
  });
});

describe('#277 Identity variant 구분', () => {
  it('variant="avatar" 인 에이전트는 소유자 없이 글리프만 표시', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'owner') } });
    render(<Identity account={agent('a1', 'bot', 'u1')} variant="avatar" />);

    expect(screen.getByText('🤖')).toBeTruthy();
    expect(screen.queryByText('@owner')).toBeNull();
  });

  it('variant="badge" 인 에이전트는 소유자까지 전부 표시', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'owner') } });
    render(<Identity account={agent('a1', 'bot', 'u1')} variant="badge" />);

    expect(screen.getByText('🤖')).toBeTruthy();
    expect(screen.getByText('@owner')).toBeTruthy();
  });

  // 기본값이 badge 인 것은 결정이다 — variant 를 잊은 새 호출자가 정보를 **잃는** 쪽이
  // 아니라 남기는 쪽으로 떨어진다. 넘침은 눈에 보이고, 사라진 소유자는 안 보인다.
  it('variant 기본값은 badge 다', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'owner') } });
    render(<Identity account={agent('a1', 'bot', 'u1')} />);

    expect(screen.getByText('@owner')).toBeTruthy();
  });

  // 두 kind 가 한 열에 섞여 서므로 상자 크기가 같아야 한다. `h-full` 로 부모에 기대면
  // 크기를 주지 않는 부모(스레드 참여자 띠의 ring 래퍼) 아래에서 둘이 갈린다.
  it('avatar variant 의 기본 상자 크기가 사람과 에이전트에서 같다', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'owner') } });
    const human = render(<Identity account={acc('u9', 'alice')} variant="avatar" />);
    const humanBox = human.container.firstElementChild as HTMLElement;
    const size = ['h-5', 'w-5'].filter((c) => humanBox.classList.contains(c));
    cleanup();

    const bot = render(<Identity account={agent('a1', 'bot', 'u1')} variant="avatar" />);
    const botBox = bot.container.firstElementChild as HTMLElement;
    expect(['h-5', 'w-5'].filter((c) => botBox.classList.contains(c))).toEqual(size);
    expect(botBox.classList.contains('h-full')).toBe(false);
  });
});
