import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ScheduledMessageView } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { Composer } from '../src/components/Composer';
import { ApiError } from '../src/lib/api';
import { acc } from './helpers/fakeApi';

const view = (id: string, extra: Partial<ScheduledMessageView> = {}): ScheduledMessageView => ({
  id, channelId: 'c1', authorId: 'u1', threadRootId: null, body: `본문 ${id}`,
  sendAt: new Date(Date.now() + 3600_000).toISOString(),
  createdAt: new Date().toISOString(),
  sentMessageId: null, failedReason: null, canceledAt: null, ...extra,
});

/** 컴포저가 실제로 부르는 세 표면만 세운다. 나머지는 이 화면이 건드리지 않는다. */
function mount(api: {
  scheduledMessages?: ReturnType<typeof vi.fn>;
  scheduleMessage?: ReturnType<typeof vi.fn>;
  cancelScheduledMessage?: ReturnType<typeof vi.fn>;
}) {
  const full = {
    scheduledMessages: vi.fn().mockResolvedValue([]),
    scheduleMessage: vi.fn().mockResolvedValue(view('s1')),
    cancelScheduledMessage: vi.fn().mockResolvedValue(undefined),
    ...api,
  };
  setController({ typing: vi.fn(), upload: vi.fn(), api: full } as unknown as Controller);
  return full;
}

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'me'), accounts: { u1: acc('u1', 'me') } });
});
afterEach(() => cleanup());

describe('예약 발송 컴포저 (#222)', () => {
  it('시계 버튼 → 시각 입력 → 예약 요청이 나가고 컴포저가 빈다', async () => {
    const api = mount({});
    render(<Composer onSend={vi.fn()} scopeKey="c1" channelId="c1" />);

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: '나중에 보낼 말' } });
    fireEvent.click(screen.getByRole('button', { name: '나중에 보내기' }));

    const at = screen.getByLabelText('예약 시각') as HTMLInputElement;
    // 열릴 때 **미래**로 채워져야 한다 — 지금으로 채우면 그대로 눌렀을 때 서버가 400 을 준다.
    expect(new Date(at.value).getTime()).toBeGreaterThan(Date.now());

    fireEvent.change(at, { target: { value: '2030-01-01T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: '예약' }));

    await waitFor(() => expect(api.scheduleMessage).toHaveBeenCalled());
    expect(api.scheduleMessage.mock.calls[0][0]).toBe('c1');
    expect(api.scheduleMessage.mock.calls[0][1]).toBe('나중에 보낼 말');
    expect(new Date(api.scheduleMessage.mock.calls[0][2] as string).getFullYear()).toBe(2030);
    await waitFor(() => expect(textbox.value).toBe(''));
  });

  // 서버가 준 사유가 보여야 한다. 초판은 `ApiError` 를 `{ error: { message } }` 로 읽어
  // 무엇을 하든 늘 "예약에 실패했다"만 떴다 — 사람은 시각을 고칠 근거를 못 받는다.
  it('서버가 거절하면 그 사유가 보인다', async () => {
    mount({
      scheduleMessage: vi.fn().mockRejectedValue(
        new ApiError(400, 'send_at_in_past', 'send_at must be in the future'),
      ),
    });
    render(<Composer onSend={vi.fn()} scopeKey="c1" channelId="c1" />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: '나중에 보내기' }));
    fireEvent.click(screen.getByRole('button', { name: '예약' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('send_at must be in the future');
  });

  // 실패한 예약만 남아도 줄이 떠야 한다. 대기 건수로만 줄을 열면, 다 실패한 채널에서는
  // 줄 자체가 사라져 작성자가 자기 글이 안 나갔다는 것을 영영 모른다.
  it('대기가 없고 실패만 있어도 사유가 보인다', async () => {
    mount({
      scheduledMessages: vi.fn().mockResolvedValue([
        view('s9', { failedReason: 'channel_archived' }),
      ]),
    });
    render(<Composer onSend={vi.fn()} scopeKey="c1" channelId="c1" />);

    const toggle = await screen.findByRole('button', { name: /실패 1건/ });
    fireEvent.click(toggle);
    expect(await screen.findByText(/channel_archived/)).toBeTruthy();
  });

  it('취소 버튼이 취소를 부르고 목록을 다시 읽는다', async () => {
    const api = mount({
      scheduledMessages: vi.fn().mockResolvedValue([view('s2')]),
    });
    render(<Composer onSend={vi.fn()} scopeKey="c1" channelId="c1" />);

    fireEvent.click(await screen.findByRole('button', { name: /예약 1건/ }));
    fireEvent.click(await screen.findByRole('button', { name: '예약 취소' }));

    await waitFor(() => expect(api.cancelScheduledMessage).toHaveBeenCalledWith('s2'));
    await waitFor(() => expect(api.scheduledMessages).toHaveBeenCalledTimes(2));
  });

  // 조회 실패를 빈 배열로 삼키면 "예약이 하나도 없다"와 같은 화면이 된다.
  it('목록 조회가 실패하면 그 사실을 말한다', async () => {
    mount({
      scheduledMessages: vi.fn().mockRejectedValue(new ApiError(500, 'oops', '목록을 읽지 못했다')),
    });
    render(<Composer onSend={vi.fn()} scopeKey="c1" channelId="c1" />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('목록을 읽지 못했다');
  });

  // 채널이 없는 자리(단독 컴포저)에는 버튼을 그리지 않는다 — 눌러도 아무 일이 없는
  // 죽은 버튼이 되기 때문이다.
  it('channelId 가 없으면 시계 버튼이 없다', () => {
    setController({ typing: vi.fn(), upload: vi.fn() } as unknown as Controller);
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    expect(screen.queryByRole('button', { name: '나중에 보내기' })).toBeNull();
  });
});
