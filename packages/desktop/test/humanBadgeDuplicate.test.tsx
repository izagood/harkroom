import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
// **바꾼 프로덕션 파일을 직접 들여온다.** `MessageItem` 만 그리면 `Identity` 가 통째로
// 다른 것으로 바뀌어도(가짜 컴포넌트로 대체돼도) 여기가 초록으로 남는다.
import { Identity, resetAvatarCache } from '../src/components/Identity';
import { acc, msg } from './helpers/fakeApi';

// #365: 사람 메시지 한 줄에 같은 아바타가 두 번 그려졌다. `MessageItem` 이 `Identity` 를
// 두 번 부르는데(거터의 `variant="avatar"`, 이름 옆의 `variant="badge"`) 사람 분기에
// variant 분기가 없어 두 호출이 같은 아바타를 돌려줬다.
//
// jsdom 에는 레이아웃이 없다 — 두 아바타가 겹치는지 픽셀로 재지 못한다. 그래서
// **DOM 의 개수와 구조**로 단언한다. 특히 "아바타가 있다"가 아니라 **몇 개인가**를
// 세는 것이 요점이다: 있다만 보면 둘이어도 초록이라 이 결함을 통째로 놓친다.

const fakeController = () => {
  const c = {
    toggleReaction: vi.fn(async () => undefined),
    openThread: vi.fn(async () => undefined),
    fetchAvatar: vi.fn(async () => new Blob(['x'], { type: 'image/png' })),
  };
  setController(c as unknown as Controller);
  return c;
};

const agent = (id: string, handle: string, ownerAccountId: string | null) =>
  ({ ...acc(id, handle, 'agent'), ownerAccountId });

/** 거터는 클래스 문자열이 아니라 testid 로 찾는다 — 스타일을 손봐도 같은 것을 지킨다. */
const gutter = () => screen.getByTestId('author-gutter');
/** 이름줄은 작성자 이름의 부모다 — flex 컨테이너 하나에 이름·배지·시각이 줄줄이 선다. */
const nameRow = () => screen.getByTestId('author-name').parentElement!;

beforeEach(() => {
  useAppStore.getState().reset();
  resetAvatarCache();
});
afterEach(() => cleanup());

describe('#365 사람 메시지의 아바타 중복', () => {
  // 회귀 1: **개수**를 센다. 사진을 걸어 `identity-avatar` 로 세는 것이 가장 곧다 —
  // 아바타를 낸 자리에만 붙는 표식이라 "아바타가 몇 개인가"와 같은 질문이 된다.
  it('사진을 건 사람 메시지 한 줄에 아바타가 정확히 하나다', async () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'alice', 'human', false, { avatarAttachmentId: 'att-1' }) },
    });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u1')} />);

    await within(gutter()).findByTestId('identity-avatar');
    expect(screen.getAllByTestId('identity-avatar')).toHaveLength(1);
  });

  // 사진이 없는 계정이 대다수 경로다(#159 폴백). 이니셜은 아바타 상자만 내므로
  // 이니셜 개수가 곧 아바타 개수다 — 이름줄의 handle 은 소문자라 섞이지 않는다.
  it('사진이 없는 사람 메시지 한 줄에도 아바타가 정확히 하나다', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'alice') } });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u1')} />);

    expect(screen.getAllByText('A')).toHaveLength(1);
    // 핸들은 sr-only 로도 나가므로 **이름줄 하나 + 아바타 하나 = 2** 다. 아바타가 둘이면
    // 3 이 된다 — 스크린리더에 핸들이 두 번 읽히던 것도 이 수가 지킨다.
    expect(screen.getAllByText('alice')).toHaveLength(2);
  });

  // 회귀 2: 그 하나가 **거터의 것**이다. 개수만 세면 "거터에서 사라지고 이름 옆에만
  // 남은" 경우도 초록이다 — 정확히 뒤집힌 결함인데 수는 똑같이 1 이다.
  it('남은 아바타 하나는 왼쪽 거터에 있고 이름줄에는 없다', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'alice') } });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u1')} />);

    expect(within(gutter()).getByText('A')).toBeTruthy();
    expect(within(nameRow()).queryByText('A')).toBeNull();
    // 이름줄에 아바타 상자가 아예 없다 — 사진이 걸린 계정에서도 같아야 한다.
    expect(nameRow().querySelector('[data-testid="identity-avatar"]')).toBeNull();
  });
});

describe('#365 에이전트 쪽도 같아졌다', () => {
  // 회귀 3.
  //
  // **identity 문서로 뒤집혔다.** 초판은 "거터에는 아바타만, 이름 옆에는 🤖 + 소유자 —
  // **둘 다 있어야** 한다"였고, 근거는 "#277 이 거터에서 뺐으니 이름줄에는 남아야 한다"
  // 였다. 그 근거는 아바타가 사람과 같아지기 전(#465) 이야기다 — 지금은 아바타가 사람과
  // 같은 마크업이라 🤖 는 같은 말을 두 번 하는 것이고, 종류·소유자는 프로필(#475)이
  // 답한다. identity 문서: *"아바타만으로 누가 에이전트인지 알 수 없는 것이 의도한 결과다."*
  //
  // **뒤집힌 것은 이름줄 쪽뿐이다.** 거터 단언은 그대로 남는다 — 🤖·소유자가 32px 열로
  // 되돌아가는 것을 막는 것이 #277 이고, 이름줄에서 뺐다고 그 위험이 사라지지 않는다.
  it('에이전트 메시지의 거터는 사람과 같은 아바타이고 🤖·소유자는 어디에도 없다', () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'bot', 'u1') },
    });
    fakeController();
    const { container } = render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'a1')} />);

    // 거터는 사람과 같은 아바타다 — 이름 첫 글자(Task 12).
    expect(within(gutter()).getByText('B')).toBeTruthy();
    // 🤖 는 거터에도, 이름줄에도, 행 어디에도 없다. 행 전체를 보는 이유는 배지를 다른
    // 자리로 옮기는 것만으로 초록이 되지 않게 하기 위해서다.
    expect(within(gutter()).queryByText('🤖')).toBeNull();
    expect(within(nameRow()).queryByText('🤖')).toBeNull();
    expect(container.textContent).not.toContain('🤖');
    // 소유자도 마찬가지다. 거터 쪽은 #277 이 계속 지키는 선이다.
    expect(gutter().textContent).not.toContain('@owner');
    expect(container.textContent).not.toContain('@owner');
  });

  // `Identity` 를 **직접** 그려 두 variant 를 마주 놓는다. `MessageItem` 만 거치면
  // 호출부가 variant 를 잘못 주는 것과 컴포넌트가 잘못 그리는 것이 구분되지 않는다.
  //
  // 초판은 "avatar=아바타만, badge=글리프+소유자로 갈린다"였다. **갈림 자체가 없어졌다**
  // (#455): badge 는 사람에게 그랬듯 에이전트에게도 아무것도 아니다.
  it('에이전트의 두 variant 는 avatar=아바타, badge=아무것도 아님이다', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'owner') } });
    const bot = agent('a1', 'bot', 'u1');

    const gut = render(<Identity account={bot} variant="avatar" />);
    // Task 12: 사람과 같은 아바타 — 이름 첫 글자.
    expect(within(gut.container).getByText('B')).toBeTruthy();
    expect(within(gut.container).queryByText('@owner')).toBeNull();
    cleanup();

    const bad = render(<Identity account={bot} variant="badge" />);
    expect(bad.container.textContent).toBe('');
    expect(bad.container.firstElementChild).toBeNull();
  });
});

describe('#365 고치면서 건드리지 않은 것', () => {
  /**
   * 회귀 4. `Identity.tsx` 에 남아 있던 #277 의 주석은 사람 분기에 variant 를 넣으면
   * "`rounded-full` 이 `rounded` 로 갈리는 식의 무관한 회귀"가 난다고 경고했다.
   * **그 경고가 실현되지 않았음**을 여기서 못 박는다 — 거터 아바타의 모양·크기·넘침
   * 계약이 그대로다. 사람 badge 를 지운 것이 avatar 자리를 스치지 않았다는 뜻이다.
   */
  it('사람 거터 아바타의 모양이 그대로다', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'alice') } });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u1')} />);

    const box = gutter().firstElementChild as HTMLElement;
    // 원이다 — 모서리만 둥근 사각(`rounded`)이 아니다.
    expect(box.classList.contains('rounded-full')).toBe(true);
    expect(box.classList.contains('rounded')).toBe(false);
    // 사진(#159)이 상자를 넘지 않는 계약.
    expect(box.classList.contains('overflow-hidden')).toBe(true);
    // 기본 상자 크기는 에이전트와 같은 `h-5 w-5` 다 — 한 열에 섞여 서므로 갈리면 안 된다.
    const size = ['h-5', 'w-5'].filter((c) => box.classList.contains(c));
    const botBox = render(<Identity account={agent('a1', 'bot', null)} variant="avatar" />)
      .container.firstElementChild as HTMLElement;
    expect(['h-5', 'w-5'].filter((c) => botBox.classList.contains(c))).toEqual(size);
  });
});

describe('#365 배지가 없는 이름줄', () => {
  /**
   * 회귀 5. "아무것도 아니다"를 `null` 로 내는 것과 **빈 상자**로 내는 것은 다르다 —
   * 빈 `<span className="ml-1" />` 을 돌려주면 화면에는 이름과 시각 사이에 설명할 수
   * 없는 빈 칸이 남는다. jsdom 은 그 칸을 픽셀로 재지 못하므로 **그 칸을 만드는 것**
   * 두 가지를 DOM 으로 본다: 빈 자식 요소가 없고, 여백이 자식의 좌우 margin 이 아니라
   * 컨테이너의 `gap` 에서 난다(자식이 사라지면 그 몫의 여백도 함께 사라진다).
   */
  it('사람 이름줄에 빈 자리가 남지 않는다', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'alice') } });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u1')} />);

    const children = Array.from(nameRow().children) as HTMLElement[];
    // 그려진 것은 전부 무언가를 말한다 — 아무 글자도 없는 자식은 빈 칸일 뿐이다.
    expect(children.filter((el) => el.textContent?.trim() === '')).toEqual([]);
    // 여백은 컨테이너가 낸다. 자식이 `ml-*`/`mr-*` 로 여백을 들고 있으면 그 자식이
    // 사라져도 이웃의 여백이 남아 이름줄이 어긋난다.
    expect(children.filter((el) => /\bm[lrxe]-/.test(el.className))).toEqual([]);
    expect(nameRow().className).toMatch(/\bgap-2\b/);
  });

  /**
   * 초판은 여기서 "에이전트 이름줄에는 배지가 **남아 있고** 역시 빈 자리가 없다"를 쟀다.
   * 근거는 *"같은 잣대를 대 두면 '빈 자식이 없다'가 배지를 통째로 없애서 만족되는 것이
   * 아님이 드러난다"* 였다 — 그때는 에이전트가 배지를 갖는 쪽이었으므로 이 대조가 성립했다.
   *
   * **identity 문서로 뒤집혔다.** 이제 에이전트도 사람과 같은 상태다: 이름줄에 배지
   * 자리가 **아예 없다**. 그래서 이 대조는 사라지지만, #365 가 지키려던 것 — "빈 배지
   * 자리가 남지 않는다" — 는 사라지지 않고 **에이전트로 확장**된다. 사람 쪽만 재면
   * 에이전트 자리에 빈 상자를 되돌려도 초록이기 때문이다.
   *
   * 초판이 걱정한 "배지를 없애서 만족되는 것" 은 이제 걱정이 아니라 **의도**이고,
   * 배지가 정말 없다는 사실은 바로 위 `#365 에이전트 쪽도 같아졌다` 가 따로 잰다.
   */
  it('에이전트 이름줄에도 빈 배지 자리가 남지 않는다', () => {
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'owner'), a1: agent('a1', 'bot', 'u1') },
    });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'a1')} />);

    const children = Array.from(nameRow().children) as HTMLElement[];
    // 사람 쪽과 **같은 잣대**다: 빈 자식이 없고, 여백은 컨테이너의 gap 에서 난다.
    expect(children.filter((el) => el.textContent?.trim() === '')).toEqual([]);
    expect(children.filter((el) => /\bm[lrxe]-/.test(el.className))).toEqual([]);
    expect(nameRow().className).toMatch(/\bgap-2\b/);
    // 이름줄이 답하는 것은 이제 **누가 말했나** 하나뿐이다 — 사람과 같다.
    expect(within(nameRow()).getByTestId('author-name').textContent).toBe('bot');
  });
});
