// **인박스는 열어 둔 채로 살아 있어야 한다** (2026-09-10 신고).
//
// 신고 그대로: *"Inbox에 실시간 반영이 안돼. 메시지가 왔는데 Inbox를 닫았다 열어야 반영돼."*
//
// 원인은 조회 시점 하나였다 — `Inbox` 는 `open` 이 바뀔 때만 `api.inbox()` 를 불렀다.
// 실시간 신호는 이미 있었다(`inbox.updated` → `controller.refreshUnread`): 레일 배지와 독
// 배지는 그것으로 즉시 움직였고, **같은 화면의 목록만** 움직이지 않았다. 배지가 늘었는데
// 목록이 그대로면 사람은 둘 중 어느 쪽도 믿을 수 없다.
//
// 그래서 이 파일이 재는 것은 줄의 모양이 아니다(그것은 `inbox.test.tsx` 의 몫이다).
// **신호가 이 화면에 닿는가**, 그리고 닿는 값이 조회를 헛돌리지 않는가 — 둘뿐이다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import type { InboxEntry } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { Inbox } from '../src/components/Inbox';
import { acc, chan } from './helpers/fakeApi';

const entry = (id: number, channelId = 'c1'): InboxEntry => ({
  id, messageId: `m${id}`, reason: 'mention', readAt: null, channelId, authorId: 'u2',
  body: '이거 봐줘', meta: {}, createdAt: '2024-01-01T00:00:00.000Z', threadRootId: null,
});

/**
 * 서버가 들고 있는 목록을 **테스트가 바꿀 수 있게** 잡아 둔다. 조회 하나를 목으로 고정하면
 * "다시 읽었는가"까지는 재도 "다시 읽어서 새 것을 봤는가"는 못 잰다 — 신고의 내용이 후자다.
 */
const mount = (rows: InboxEntry[]) => {
  const server = { rows };
  const inbox = vi.fn(async () => server.rows);
  setController({
    api: { inbox },
    openMessage: vi.fn(async () => undefined),
    openChannel: vi.fn(async () => undefined),
    answerAsk: vi.fn(async () => undefined),
  } as unknown as Controller);
  const view = render(<Inbox open onClose={vi.fn()} />);
  return { server, inbox, view };
};

/** 서버가 알려 온 것 하나. 컨트롤러가 `inbox.updated` 를 받으면 이 수가 오른다. */
const serverSaysInboxChanged = (): void => {
  act(() => {
    const s = useAppStore.getState();
    s.set({ inboxRevision: s.inboxRevision + 1 });
  });
};

beforeEach(() => {
  localStorage.clear();
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'me'), channels: [chan('c1', 'general')] });
});

afterEach(() => {
  usePrefsStore.getState().setLocale('system');
  cleanup();
  setController(null as unknown as Controller);
  vi.restoreAllMocks();
});

describe('인박스는 열어 둔 채로 갱신된다 (2026-09-10)', () => {
  // **이 파일의 심장.** 닫았다 열지 않고 새 줄이 서는가.
  it('열려 있는 동안 서버가 알려 오면 새 줄이 그려진다', async () => {
    const { server } = mount([entry(1)]);
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());
    expect(screen.queryByTestId('inbox-entry-2')).toBeNull();

    server.rows = [entry(1), entry(2)];
    serverSaysInboxChanged();

    await waitFor(() => expect(screen.getByTestId('inbox-entry-2')).toBeTruthy());
  });

  // 사라진 줄도 같은 신호로 사라져야 한다 — 답이 온 물음이 목록에 남아 있으면, 그 목록은
  // 아직 나를 막는 것이 있다고 거짓말한다.
  it('서버에서 빠진 줄은 같은 신호로 사라진다', async () => {
    const { server } = mount([entry(1), entry(2)]);
    await waitFor(() => expect(screen.getByTestId('inbox-entry-2')).toBeTruthy());

    server.rows = [entry(1)];
    serverSaysInboxChanged();

    await waitFor(() => expect(screen.queryByTestId('inbox-entry-2')).toBeNull());
    expect(screen.getByTestId('inbox-entry-1')).toBeTruthy();
  });

  // 갱신은 **조용해야** 한다. 목록이 "불러오는 중"으로 되돌아가면 읽던 자리가 사라진다 —
  // 사람은 이 조회를 기다리고 있지 않다.
  it('갱신 중에 목록이 "불러오는 중"으로 되돌아가지 않는다', async () => {
    const { server } = mount([entry(1)]);
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    server.rows = [entry(1), entry(2)];
    serverSaysInboxChanged();
    // 조회가 아직 안 돌아온 이 시점에도 줄은 그대로 서 있어야 한다.
    expect(screen.getByTestId('inbox-entry-1')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-2')).toBeTruthy());
  });

  // 헛조회를 재는 자리. 신호가 같은 값이면 아무 일도 없어야 한다 — 리렌더마다 조회가
  // 나가면 인박스를 열어 두는 것이 서버를 두드리는 일이 된다.
  it('같은 값이 다시 흘러도 조회하지 않는다', async () => {
    const { inbox } = mount([entry(1)]);
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());
    const before = inbox.mock.calls.length;

    // 인박스와 무관한 스토어 변화 하나. `inboxRevision` 은 그대로다.
    act(() => { useAppStore.getState().set({ online: ['u2'] }); });

    expect(inbox.mock.calls.length).toBe(before);
  });

  // 닫혀 있는 동안 온 것은 **여는 조회 하나로** 온다. 닫힌 화면을 위해 조회를 내면 그것은
  // 아무도 안 보는 목록을 위한 왕복이고, 열 때 같은 조회가 또 나가면 둘이 겹친다.
  it('닫혀 있는 동안에는 조회하지 않고, 다시 열면 한 번만 조회한다', async () => {
    const { server, inbox, view } = mount([entry(1)]);
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    view.rerender(<Inbox open={false} onClose={vi.fn()} />);
    const closed = inbox.mock.calls.length;

    server.rows = [entry(1), entry(2)];
    serverSaysInboxChanged();
    expect(inbox.mock.calls.length).toBe(closed);

    view.rerender(<Inbox open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('inbox-entry-2')).toBeTruthy());
    expect(inbox.mock.calls.length).toBe(closed + 1);
  });
});
