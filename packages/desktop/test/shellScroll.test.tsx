// **앱 껍데기는 스크롤되지 않는다.**
//
// 실측 2026-09-08(창 1400×578, 인박스 30줄, Chrome): 인박스를 열자
// `documentElement.scrollHeight` 가 578 → **2450** 으로 뛰었고, 줄을 한 번 누르자
// `scrollTop` 이 0 → 317 로 밀려 **앱 전체가 창 위로 올라갔다**. 상단 바·채널 머리·인박스
// 머리가 잘려 나가고 아래에는 body 바탕만 남는다. 스크롤바가 없어 되돌릴 길도 없다.
//
// 원인은 둘이 겹친 것이고, 이 파일은 그 둘을 각각 붙잡는다.
//
// ## 1. `sr-only` 가 컨테이닝 블록을 벗어난다
//
// Tailwind 의 `sr-only` 는 `position: absolute` 다. `Identity` 아바타는 이름을 그 방식으로
// 내는데, 껍데기 span 에 `relative` 가 없으면 **컨테이닝 블록이 초기 컨테이닝 블록(ICB)이
// 된다.** 그러면 인박스 자리·가로줄·세로칸에 걸린 `overflow-hidden` 이 **하나도 안 듣는다**
// — 자르는 상자는 컨테이닝 블록 사슬 위에 있을 때만 자르기 때문이다. 목록이 길어진 만큼
// 스팬이 문서 좌표 저 아래에 깔리고, 그 길이가 그대로 문서의 스크롤 범위가 된다.
//
// 사이드바(`aside.relative`)와 메시지 줄(`div.group relative`)은 우연히 `relative` 가 있어
// 무사했다. 인박스 줄에만 없었고, 인박스가 `Overlay`(`fixed` = positioned)를 벗은
// `d1fb73a8e` 부터 그 우연한 울타리가 사라졌다.
//
// ## 2. 인자 없는 `scrollIntoView()` 가 문서까지 끌어올린다
//
// 옵션을 안 주면 `block: 'start'` 다 — **문서를 포함한 모든 스크롤 조상**을 그 요소가
// 맨 위에 오도록 민다. 1 이 문서를 스크롤 가능하게 만들어 두면, 이 호출이 방아쇠가 된다.
// `nearest` 는 필요한 만큼만 움직이므로 바깥 상자를 끌지 않는다(실측: 같은 요소에
// `nearest` 는 `scrollTop` 0 유지, 무인자는 169.5 로 점프).
//
// 1 만 고쳐도 오늘의 증상은 사라지지만 둘 다 고친다: 1 은 이 한 자리의 사실이고 2 는
// **다음에 또 abspos 가 새면 같은 증상이 그대로 돌아온다**는 구조다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { InboxEntry } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Workspace } from '../src/components/Workspace';
import { Identity } from '../src/components/Identity';
import { acc, chan, fakeApi, msg } from './helpers/fakeApi';

const entry = (id: number, channelId: string): InboxEntry => ({
  id, messageId: `m${id}`, reason: 'mention', readAt: null, channelId, authorId: 'u2',
  body: '이거 봐줘', meta: {}, createdAt: '2024-01-01T00:00:00.000Z', threadRootId: null,
});

/** `inboxPane.test.tsx` 와 같은 이유로 `Workspace` 를 통째로 띄운다 — 재는 것이 **껍데기**다. */
const mount = (rows: InboxEntry[], extra: Record<string, unknown> = {}) => {
  const api = fakeApi();
  setController({
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
  } as unknown as Controller);
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
};

const openInbox = (): void => { fireEvent.click(screen.getByText('Inbox')); };

/**
 * jsdom 에는 `scrollIntoView` 가 없다 — 제품 코드가 `?.()` 로 부르는 이유다(그 옵셔널을
 * 빼면 이 스위트 전체가 죽는다). 그래서 **여기서 심어 두고** 무엇을 받았는지 본다.
 * 자리를 비워 두면 호출 자체가 조용히 사라져 이 파일은 아무것도 재지 못한다.
 */
let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
  scrollIntoView = vi.fn();
  (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
});
afterEach(() => {
  cleanup();
  setController(null as unknown as Controller);
  delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
});

describe('sr-only 는 자기 상자를 벗어나지 않는다', () => {
  /**
   * 이름을 내는 컴포넌트가 자기 abspos 를 책임진다. 인박스 줄에만 `relative` 를 붙이면
   * 다음 목록에서 같은 함정을 다시 밟는다 — `Identity` 는 열 군데 넘는 자리에 선다.
   */
  it('아바타 껍데기가 컨테이닝 블록을 세운다', () => {
    render(<Identity account={acc('u2', 'someone')} variant="avatar" />);
    const srOnly = document.querySelectorAll('.sr-only');
    expect(srOnly.length).toBeGreaterThan(0);
    for (const s of srOnly) {
      expect(s.parentElement!.className).toMatch(/(^|\s)relative(\s|$)/);
    }
  });

  /**
   * 위 규칙이 **실제 화면에서** 지켜지는지 본다. 단위로만 재면 인박스 줄이 나중에
   * 자기 마크업으로 아바타를 그리기 시작해도 초록이 남는다.
   */
  it('인박스 줄의 모든 sr-only 가 positioned 부모를 갖는다', async () => {
    mount([entry(1, 'c1'), entry(2, 'c1')]);
    openInbox();
    const pane = await screen.findByTestId('inbox-pane');
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    const srOnly = pane.querySelectorAll('.sr-only');
    expect(srOnly.length).toBeGreaterThan(0);
    for (const s of srOnly) {
      // `relative`·`absolute`·`fixed`·`sticky` 중 무엇이든 상자를 세우면 된다.
      expect(s.parentElement!.className).toMatch(/(^|\s)(relative|absolute|fixed|sticky)(\s|$)/);
    }
  });
});

describe('scrollIntoView 는 바깥 상자를 끌지 않는다', () => {
  /**
   * 채널을 열면 바닥으로 내려간다(`ChannelPane` 의 `bottomRef`). 인자 없이 부르면
   * `block:'start'` 라 **문서까지** 밀린다 — 앱 전체가 창 위로 올라가는 그 움직임이다.
   */
  it('채널 바닥으로 내려갈 때 nearest 로 부른다', () => {
    mount([]);
    expect(scrollIntoView).toHaveBeenCalled();
    for (const call of scrollIntoView.mock.calls) {
      expect(call[0]).toEqual({ block: 'nearest' });
    }
  });

  /** 강조로 이동할 때도 같다(`MessageItem`). 인박스에서 줄을 눌렀을 때 지나는 길이다. */
  it('강조된 메시지로 이동할 때 nearest 로 부른다', async () => {
    mount([], { highlightedMessageId: 'm1' });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    for (const call of scrollIntoView.mock.calls) {
      expect(call[0]).toEqual({ block: 'nearest' });
    }
  });
});

describe('인박스를 여는 포커스가 껍데기를 밀지 않는다', () => {
  /**
   * 자리를 열면 포커스가 그 자리로 들어간다(`Inbox` 의 주석: 트랩 대신 이것을 둔다).
   * 포커스는 기본으로 **대상을 보이게 스크롤한다** — 그 길도 닫아 둔다.
   */
  it('preventScroll 로 포커스를 준다', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    mount([entry(1, 'c1')]);
    openInbox();
    const pane = await screen.findByTestId('inbox-pane');

    // `contexts` 가 각 호출의 `this` 다 — 프로토타입 스파이라 "누구에게 준 포커스인가"를
    // 이것으로만 가른다(`instances` 는 생성자 호출용이라 여기서는 비어 있다).
    const paneFocus = focus.mock.calls.filter((_c, i) => focus.mock.contexts[i] === pane);
    expect(paneFocus.length).toBeGreaterThan(0);
    for (const call of paneFocus) {
      expect(call[0]).toEqual({ preventScroll: true });
    }
    focus.mockRestore();
  });
});
