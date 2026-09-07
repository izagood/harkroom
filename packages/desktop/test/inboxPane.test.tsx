// 인박스는 **모달이 아니라 자리**다(정본 문서 `docs/desktop-remaining-gaps.html` C2).
//
// 문서의 진단: *"지금은 채널 위에 뜨는 모달이라 스레드를 보면서 열어 둘 수 없다. 막는 말을
// 확인하면서 그 스레드를 여는 것이 기본 동작인데, 모달이 그걸 막는다."*
//
// 그래서 이 파일이 재는 것은 **인박스가 잘 그려지는가**가 아니다(그것은 `inbox.test.tsx` 의
// 몫이다). 여기서 재는 것은 딱 하나다 — **인박스와 스레드가 같은 화면에 동시에 서는가.**
// 껍데기가 다시 모달로 돌아가면 이 파일이 빨개진다.
//
// `Workspace` 를 **통째로** 띄운다. `mentionClick.test.tsx` 가 같은 이유로 그렇게 한다:
// 인박스를 단독으로 렌더하면 "모달이 아니다"를 증명할 수 없다 — 모달이 막는 것은 자기
// 자신이 아니라 **옆에 선 것**이고, 그 옆이 있는 곳이 이 화면이다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { InboxEntry } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Workspace } from '../src/components/Workspace';
import { acc, chan, fakeApi, msg } from './helpers/fakeApi';

const entry = (id: number, reason: InboxEntry['reason'], channelId: string): InboxEntry => ({
  id, messageId: `m${id}`, reason, readAt: null, channelId, authorId: 'u2', body: '이거 봐줘',
  meta: {}, createdAt: '2024-01-01T00:00:00.000Z', threadRootId: null,
});

/**
 * `Workspace` 가 실제로 도는 데 필요한 최소 컨트롤러. `openMessage` 는 목이지만 **스레드가
 * 열리는 것은 목으로 흉내내지 않는다** — 인박스가 `openMessage` 를 부른 뒤에도 자기 자리에
 * 남아 있는지가 물음이므로, 스레드는 스토어를 직접 세워 띄운다.
 */
const mount = (rows: InboxEntry[], extra: Record<string, unknown> = {}) => {
  const api = fakeApi();
  const c = {
    api: { ...api, inbox: vi.fn(async () => rows) },
    openMessage: vi.fn(async () => undefined),
    openChannel: vi.fn().mockResolvedValue(undefined),
    openThread: vi.fn(),
    closeThread: vi.fn(),
    answerAsk: vi.fn(async () => undefined),
    startDm: vi.fn(),
    logout: vi.fn(),
    notifyTyping: vi.fn(),
    refreshAccounts: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    loadOlder: vi.fn(),
    goBack: vi.fn().mockResolvedValue(false),
    goForward: vi.fn().mockResolvedValue(false),
  };
  setController(c as unknown as Controller);
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
    channels: [chan('c1', 'general')],
    connected: true,
    activeChannelId: 'c1',
    messages: { c1: [msg('m1', 'c1', 1, '뿌리', 'u2')] },
    ...extra,
  });
  render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);
  return c;
};

/** 여는 입구는 이번 작업에서 바뀌지 않는다 — 사이드바 홈 맨 위 한 줄(`desktop-rail.html`). */
const openInbox = (): void => { fireEvent.click(screen.getByText('Inbox')); };

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
});
afterEach(() => { cleanup(); setController(null as unknown as Controller); });

describe('인박스는 자리다 — 모달이 아니다 (#488 C2)', () => {
  /**
   * **이 파일의 심장.** 문서가 *"막는 말을 확인하면서 그 스레드를 여는 것이 기본 동작"*
   * 이라고 한 그 동작을 그대로 흉내낸다: 스레드가 열려 있는 채로 인박스를 열고, 둘이 같이
   * 서 있는지 본다. 모달이면 인박스가 스레드를 덮는다.
   */
  it('스레드가 열려 있는 채로 인박스를 열면 둘이 동시에 보인다', async () => {
    mount([entry(1, 'mention', 'c1')], { threadRootId: 'm1' });

    // 먼저 스레드가 서 있다.
    expect(screen.getByText('Thread')).toBeTruthy();

    openInbox();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    // **둘 다** 있다. 하나가 다른 하나를 밀어내지 않는다.
    expect(screen.getByText('Thread')).toBeTruthy();
    expect(screen.getByTestId('inbox-pane')).toBeTruthy();
  });

  /**
   * 반대 순서도 같아야 한다 — 인박스를 먼저 열고 거기서 스레드로 들어가는 것이 문서가 말한
   * **기본 동작**이다. 여기서 인박스가 스스로 닫히면 "확인하면서 여는 것"이 되지 못한다.
   *
   * `openMessage` 는 목이라 스레드를 실제로 열지 않으므로, 그 뒤 스토어를 세워 스레드가
   * 떴을 때를 만든다. 재는 것은 **인박스가 그때까지 살아 있는가**다.
   */
  it('인박스에서 항목을 눌러 스레드로 들어가도 인박스가 닫히지 않는다', async () => {
    const c = mount([entry(7, 'thread_reply', 'c1')]);

    openInbox();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-7')).toBeTruthy());
    fireEvent.click(screen.getByTestId('inbox-entry-7'));

    // 이동 경로는 그대로다(#178·#228).
    expect(c.openMessage).toHaveBeenCalledWith('m7');
    // 그리고 인박스는 **남는다.** 모달 시절에는 이 자리에서 `onClose` 가 불렸다.
    expect(screen.getByTestId('inbox-pane')).toBeTruthy();

    // 그 이동이 실제로 스레드를 열었을 때에도 둘이 함께 선다.
    useAppStore.getState().set({ threadRootId: 'm1' });
    await waitFor(() => expect(screen.getByText('Thread')).toBeTruthy());
    expect(screen.getByTestId('inbox-pane')).toBeTruthy();
  });

  /**
   * **모달의 부품이 남아 있지 않은지** 직접 잰다. 위 두 테스트는 "둘이 보인다"를 재지만,
   * jsdom 에는 레이아웃이 없어 스크림이 덮고 있어도 `getByText` 는 통과한다 — 그래서
   * 껍데기 자체를 확인한다: `role="dialog"` 도, 화면을 덮는 스크림도 없어야 한다.
   */
  it('dialog 도 스크림도 없다 — 껍데기가 모달의 것이 아니다', async () => {
    mount([entry(1, 'mention', 'c1')]);

    openInbox();
    const pane = await screen.findByTestId('inbox-pane');

    // 모달이었다면 `Overlay` 가 `role="dialog"` 를 줬다.
    expect(pane.getAttribute('role')).not.toBe('dialog');
    expect(screen.queryByRole('dialog', { name: '인박스' })).toBeNull();
    // 스크림은 `fixed inset-0` 이었다. 그 값을 가진 조상이 있으면 아직 화면을 덮고 있다.
    expect(pane.closest('.fixed')).toBeNull();
  });

  /**
   * 자리는 **형제**여야 한다. 채널·스레드와 같은 가로줄에 서지 않으면 폭을 나눠 갖지 못하고,
   * 그 순간 다시 무언가를 덮는 것이 된다.
   *
   * 축까지 함께 잰다 — 인박스는 채널의 **왼쪽**이다(근거는 `Workspace.tsx` 주석). 스레드가
   * 채널 오른쪽에 서므로 인박스가 같은 쪽에 서면 스레드와 자리를 다투게 된다(#141 에서
   * 터미널이 이미 스레드와 그 자리를 다툰다 — 셋째를 더 넣지 않는다).
   */
  it('채널·스레드와 같은 가로줄의 형제이고, 채널 왼쪽에 선다', async () => {
    mount([entry(1, 'mention', 'c1')], { threadRootId: 'm1' });

    openInbox();
    const pane = await screen.findByTestId('inbox-pane');
    const kids = Array.from(pane.parentElement!.children);

    const channel = screen.getByTestId('channel-pane');
    const thread = screen.getByTestId('thread-pane');
    // 셋이 한 줄에 있다 — 부모가 같다.
    expect(kids).toContain(channel);
    expect(kids).toContain(thread);

    // 인박스가 채널보다 앞(= 왼쪽)이고, 스레드는 채널보다 뒤(= 오른쪽)다.
    expect(kids.indexOf(pane)).toBeLessThan(kids.indexOf(channel));
    expect(kids.indexOf(thread)).toBeGreaterThan(kids.indexOf(channel));
  });
});

describe('인박스 자리 — 닫는 길과 키보드 (#488 C2)', () => {
  /**
   * `Overlay` 를 벗으면 그 프리미티브가 주던 Esc 가 함께 사라진다. **잃으면 안 된다** —
   * 키보드만 쓰는 사람에게 닫는 길이 없어지기 때문이다.
   *
   * 다만 뜻이 달라진다: 모달의 Esc 는 "덮은 것을 걷는다"였고, 자리의 Esc 는 "이 자리를
   * 접는다"다. `⌘\`(사이드바 접기)와 같은 종류의 조작이다.
   */
  it('Esc 로 닫힌다 — 포커스가 인박스 밖에 있어도', async () => {
    mount([entry(1, 'mention', 'c1')]);

    openInbox();
    await screen.findByTestId('inbox-pane');

    // **패널 밖(document.body)에서 누른다.** 패널 `onKeyDown` 으로 받으면 여기서 죽는다 —
    // `Overlay` 가 document 리스너를 쓴 이유와 같다(`overlayEscape.test.tsx`).
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('inbox-pane')).toBeNull());
  });

  /**
   * Esc 는 **더 위에 있는 것부터** 걷는다. 인박스가 열려 있을 때 Esc 가 인박스를 닫으면서
   * 그 위에 뜬 오버레이(디렉터리·검색 등)를 그대로 두면, 사람은 한 번의 조작으로 **보고
   * 있지 않은 것**을 닫는다.
   *
   * `Overlay` 는 이미 스택의 맨 위만 닫는 규칙을 갖고 있다. 자리는 그 스택보다 **아래**라
   * 오버레이가 하나라도 열려 있으면 Esc 를 양보해야 한다.
   */
  it('오버레이가 위에 열려 있으면 Esc 를 양보한다', async () => {
    mount([entry(1, 'mention', 'c1')]);

    openInbox();
    await screen.findByTestId('inbox-pane');

    // 디렉터리를 위에 띄운다 — `Overlay` 를 계속 쓰는 화면이다(건드리지 않았다).
    fireEvent.click(screen.getByText('Directory'));
    expect(await screen.findByRole('dialog', { name: '디렉터리' })).toBeTruthy();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    // 디렉터리가 닫히고 인박스는 남는다.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '디렉터리' })).toBeNull());
    expect(screen.getByTestId('inbox-pane')).toBeTruthy();

    // 한 번 더 누르면 이제 인박스가 접힌다.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('inbox-pane')).toBeNull());
  });

  /** 닫는 버튼도 남는다 — 마우스만 쓰는 사람에게 Esc 는 없는 길이다. */
  it('닫기 버튼이 키보드로 닿고 눌러서 닫힌다', async () => {
    mount([entry(1, 'mention', 'c1')]);

    openInbox();
    await screen.findByTestId('inbox-pane');

    const close = screen.getByRole('button', { name: '인박스 닫기' });
    close.focus();
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByTestId('inbox-pane')).toBeNull());
  });

  /**
   * 자리는 **자기가 무엇인지 말해야 한다.** `role="dialog"` 와 그 접근성 이름을 잃었으므로
   * 그 대신 이름 있는 구획이어야 한다 — 스크린리더가 랜드마크 목록에서 이 자리를 찾는
   * 길이고, 모달이 아닌 자리에 남는 유일한 길이다.
   */
  it('이름 있는 구획이다 — 랜드마크로 찾을 수 있다', async () => {
    mount([entry(1, 'mention', 'c1')]);

    openInbox();
    await screen.findByTestId('inbox-pane');
    expect(screen.getByRole('complementary', { name: '인박스' })).toBeTruthy();
  });

  /**
   * **열면 포커스가 그 자리로 간다.** 모달의 포커스 트랩을 대신하는 것은 트랩이 아니라
   * 이것이다: 자리는 갇히지 않아야 하지만(채널·스레드로 탭이 나가야 한다), 열었는데 포커스가
   * 다른 데 남아 있으면 키보드 사용자에게는 **아무 일도 일어나지 않은 것**이다.
   *
   * 트랩을 두지 않는 것이 이 작업의 요지 그 자체다 — 인박스를 보면서 스레드로 탭해 갈 수
   * 있어야 하고, 트랩은 정확히 그것을 막는다.
   */
  it('열면 포커스가 인박스 안으로 들어가고, 갇히지는 않는다', async () => {
    mount([entry(1, 'mention', 'c1')], { threadRootId: 'm1' });

    openInbox();
    const pane = await screen.findByTestId('inbox-pane');
    await waitFor(() => expect(pane.contains(document.activeElement)).toBe(true));

    // 스레드 안의 것에 포커스를 줘 본다 — 트랩이 있으면 되돌려진다.
    const outside = screen.getByRole('separator', { name: '스레드 너비 조절' }) as HTMLElement;
    outside.focus();
    expect(document.activeElement).toBe(outside);
  });
});

describe('인박스 자리 — 좁은 창 (#488 C2)', () => {
  /**
   * 좁은 창의 답은 **새 수단이 아니라 이미 있는 접기**다(`desktop-rail.html`: *"좁은
   * 창에서는 레일만 남기고 패널을 접는 단계가 하나 더 필요하다"* — `Workspace.tsx` 가
   * 그 단계를 `⌘\` 로 이미 얹었다).
   *
   * 그래서 여기서 재는 것은 **`⌘\` 가 인박스가 열린 채로도 그대로 듣는가**다. 인박스가
   * Esc 를 document 리스너로 받으므로 `⌘\` 를 삼킬 자리가 생겼다 — 삼키면 좁은 창에서
   * 빠져나올 길이 사라진다.
   */
  it('인박스가 열려 있어도 ⌘\\ 로 사이드바를 접을 수 있다 — 인박스는 남는다', async () => {
    mount([entry(1, 'mention', 'c1')], { threadRootId: 'm1' });

    openInbox();
    await screen.findByTestId('inbox-pane');
    expect(screen.getByText('Directory')).toBeTruthy();

    fireEvent.keyDown(document, { key: '\\', metaKey: true });

    // 사이드바가 접혔다: 홈 목록이 사라지고 헤더에 펼치기 버튼이 선다.
    await waitFor(() => expect(screen.queryByText('Directory')).toBeNull());
    expect(screen.getByRole('button', { name: '사이드바 펼치기' })).toBeTruthy();
    // 접은 것은 사이드바뿐이다 — 인박스와 스레드는 그 자리에 있다.
    expect(screen.getByTestId('inbox-pane')).toBeTruthy();
    expect(screen.getByText('Thread')).toBeTruthy();
  });

  /**
   * 자리는 **줄어들되 사라지지 않는다.** `min-width` 없이 `flex` 에 맡기면 좁은 창에서
   * 폭이 0 에 가까워지고, 사람은 그것을 "인박스가 안 열렸다"로 읽는다 — 되돌릴 손잡이
   * (닫기 버튼)도 그 사라진 자리에 있으니 빠져나올 길이 없다. `MIN_CHANNEL_WIDTH` 의
   * 주석이 채널에 대해 같은 것을 적어 뒀다: 이 값이 지키는 것은 편안함이 아니라
   * **되돌릴 수 있음**이다.
   */
  it('최소 폭을 갖는다 — 좁은 창에서 폭 0 으로 사라지지 않는다', async () => {
    mount([entry(1, 'mention', 'c1')]);

    openInbox();
    const pane = await screen.findByTestId('inbox-pane');
    // jsdom 에는 레이아웃이 없어 실제 폭을 잴 수 없다 — 인라인 스타일로 선언됐는지 본다.
    expect(parseInt(pane.style.minWidth, 10)).toBeGreaterThan(0);
  });
});
