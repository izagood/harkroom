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
    // 거터가 **누구인지는 말한다** — 없애는 것이 아니라 소유자만 뺀 것이다.
    // Task 12 이후 에이전트도 사람과 같은 아바타(이름 첫 글자 + 색)를 쓰므로 'B'(bot)다.
    expect(within(gutter()).getByText('B')).toBeTruthy();
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

  // 회귀 3: 소유자 핸들이 **메시지 어디에도** 없다.
  //
  // **identity 문서로 뒤집혔다.** 초판은 "이름 옆 배지에 소유자 핸들이 있다"였고 근거는
  // "거터에서 뺐으니 이름줄에는 남아야 한다"였다 — #277 이 고친 것은 **자리**였지 표시가
  // 아니었기 때문이다. 그 근거는 아바타가 사람과 같아지기 전(#465) 이야기다: 지금은
  // 종류·소유자·하네스를 프로필(#475)이 답하고, identity 문서가 *"이름 옆 배지와 소유자
  // 핸들은 뺀다"* 로 못 박았다. 그래서 이름줄 쪽 단언만 뒤집는다.
  //
  // **거터 쪽 단언은 그대로 남는다** — 이 파일이 지키는 것은 "소유자 핸들이 32px 고정폭
  // 열을 넘치는가"이고, 배지를 이름줄에서 뺐다고 그 결함이 사라지는 것이 아니다. 누군가
  // 소유자를 거터로 되돌리면 #277 이 그대로 재현된다.
  //
  // 소유자 표시 자체(#181)는 **디렉터리·자동완성에서 계속 살아 있다** — 그 두 자리를
  // `directory.test.tsx`·`composer.test.tsx` 의 badge 회귀선이 잰다. 여기서 그것을 다시
  // 재지 않는 이유는 이 파일이 보는 것이 **메시지 행의 거터 넘침**이기 때문이다.
  it('메시지 어디에도 소유자 핸들이 없다', () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'bot', 'u1') },
    });
    fakeController();
    const { container } = render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'a1')} />);

    // 거터에 없다 — 이것이 #277 의 원래 단언이고 여전히 유효하다.
    expect(gutter().textContent).not.toContain('@owner');
    // 이름줄에도 없다 — identity 문서로 뒤집힌 쪽이다.
    expect(screen.queryByText('@owner')).toBeNull();
    // 행 전체를 본다: 배지를 다른 자리로 옮기는 것으로는 이 단언을 만족시킬 수 없다.
    expect(container.textContent).not.toContain('@owner');
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
    const { container } = render(<ThreadPanel />);

    // 답변(에이전트)의 거터를 고른다 — 루트는 사람이라 거터가 둘이다.
    const gutters = screen.getAllByTestId('author-gutter');
    // 에이전트 거터를 sr-only 핸들로 고른다 — 글리프가 아니라 **누구인가**로 찾는다
    // (Task 12: 에이전트도 사람과 같은 아바타를 쓴다).
    const agentGutters = gutters.filter((g) => g.textContent?.includes('bot'));
    expect(agentGutters).toHaveLength(1);
    expect(agentGutters[0]!.textContent).not.toContain('@owner');
    // 초판은 여기서 "소유자는 스레드 안에서도 이름줄에는 남아 있다(#181)" 를 쟀다.
    // **identity 문서로 뒤집혔다** — 이름줄 배지가 사라졌으므로 스레드에도 없다. 거터
    // 단언(위)이 이 테스트의 본론이고, 그것은 그대로다. 이름줄 쪽은 "없다"로 뒤집어
    // 재는데, 지우면 소유자가 스레드 어딘가로 되돌아와도 아무도 모르기 때문이다.
    //
    // 루트 작성자의 핸들이 'owner' 라 `@owner` 가 우연히 나올 수 있다 — 그래서 배지
    // 전용 문자열이 아니라 행 전체 텍스트로 본다. 이름줄은 `@` 없이 핸들만 낸다.
    expect(container.textContent).not.toContain('@owner');
  });
});

describe('#277 Identity variant 구분', () => {
  it('variant="avatar" 인 에이전트는 소유자 없이 아바타만 표시', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'owner') } });
    render(<Identity account={agent('a1', 'bot', 'u1')} variant="avatar" />);

    // Task 12: 사람과 같은 아바타 — 이름 첫 글자. 소유자는 여전히 없다(#277).
    expect(screen.getByText('B')).toBeTruthy();
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
