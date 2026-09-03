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
}, controller: Record<string, unknown> = {}) {
  const full = {
    scheduledMessages: vi.fn().mockResolvedValue([]),
    scheduleMessage: vi.fn().mockResolvedValue(view('s1')),
    cancelScheduledMessage: vi.fn().mockResolvedValue(undefined),
    ...api,
  };
  setController({
    typing: vi.fn(), upload: vi.fn(), api: full, ...controller,
  } as unknown as Controller);
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
    const [channelId, body, sendAt] = api.scheduleMessage.mock.calls[0]!;
    expect(channelId).toBe('c1');
    expect(body).toBe('나중에 보낼 말');
    expect(new Date(sendAt as string).getFullYear()).toBe(2030);
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

  // 예약 표면은 `attachmentIds` 를 받지 않는다. 그런데도 예약하고 `pending` 을 비우면
  // 이미 업로드된 첨부가 어디에도 안 붙은 채 사라진다 — 사람은 첨부까지 예약됐다고
  // 믿는다. 거절하고 이유를 말하는지, 그리고 첨부가 컴포저에 **남는지** 본다.
  it('첨부가 붙어 있으면 예약하지 않고 이유를 말한다', async () => {
    const api = mount({}, {
      upload: vi.fn(async () => ({
        id: 'a1', filename: 'note.txt', contentType: 'text/plain', sizeBytes: 12,
      })),
    });
    const { container } = render(<Composer onSend={vi.fn()} scopeKey="c1" channelId="c1" />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'note.txt', { type: 'text/plain' })] } });
    await screen.findByText(/note\.txt/);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '첨부와 함께' } });
    fireEvent.click(screen.getByRole('button', { name: '나중에 보내기' }));
    fireEvent.click(screen.getByRole('button', { name: '예약' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('첨부');
    expect(api.scheduleMessage).not.toHaveBeenCalled();
    // 첨부는 컴포저에 그대로 남는다 — 떼거나 지금 보내는 두 길이 다 열려 있어야 한다.
    expect(screen.getByText(/note\.txt/)).toBeTruthy();
  });

  // 채널이 없는 자리(단독 컴포저)에는 버튼을 그리지 않는다 — 눌러도 아무 일이 없는
  // 죽은 버튼이 되기 때문이다.
  it('channelId 가 없으면 시계 버튼이 없다', () => {
    setController({ typing: vi.fn(), upload: vi.fn() } as unknown as Controller);
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    expect(screen.queryByRole('button', { name: '나중에 보내기' })).toBeNull();
  });
});
