import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MAX_MESSAGE_BODY_CHARS, type ChannelAutoMentionRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Composer } from '../src/components/Composer';
import { Controller, setController } from '../src/state/controller';
import { ApiError } from '../src/lib/api';
import { acc, fakeApi } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';

/**
 * 긴 본문과 **실패한 전송**(#후속).
 *
 * 이 파일이 지키는 한 문장: **누른 것이 안 나갔으면 화면이 그것을 말한다.** 결함은 그 반대였다 —
 * 8000자를 넘긴 본문을 서버가 400 으로 거절하는데 컴포저의 `catch` 가 사유를 버려서, 화면에는
 * 초안이 조용히 돌아오는 것 말고 아무 일도 일어나지 않았다. 보내지지도 않고 이유도 없는 상태다.
 *
 * 그래서 축이 둘이다: (1) 넘긴 것은 **누르기 전에** 막고 얼마나 넘겼는지 보인다,
 * (2) 그래도 실패한 전송은 **사유를 남긴다**(길이만의 문제가 아니다 — 보관된 채널·잘못된
 * 첨부·끊긴 연결이 같은 길로 온다).
 *
 * 문구는 한국어로 고정해 잰다(`autoMention.test.tsx` 머리말과 같은 이유).
 */

const row = (agentAccountId: string, handle: string): ChannelAutoMentionRow =>
  ({ channelId: 'c1', agentAccountId, handle, createdBy: 'ad', createdAt: new Date().toISOString() });

const typeInto = (value: string) => {
  const box = screen.getByRole('textbox');
  // selectionStart 는 jsdom 이 change 로 갱신하지 않는다 — 커서를 끝에 두는 것을 직접 흉내낸다.
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
  return box;
};

const sendButton = () => screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement;

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  // 보냄 취소 창은 이 파일의 관심사가 아니다 — 끄고 즉시 전송 경로를 본다.
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), a1: acc('a1', 'fizz', 'agent') },
  });
  setController(new Controller(fakeApi()));
});

afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
  setController(null as unknown as Controller);
});

describe('본문 상한', () => {
  it('상한을 넘기면 전송 버튼을 누를 수 없고, Enter 로도 나가지 않는다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" />);

    const box = typeInto('가'.repeat(MAX_MESSAGE_BODY_CHARS + 1));

    expect(sendButton().disabled).toBe(true);
    // **Enter 는 버튼을 지나지 않는다** — 버튼만 막으면 키보드로 상한을 넘길 수 있다.
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    // 그리고 왜 안 나갔는지 말한다: 키보드로 누른 사람은 버튼이 흐려진 것을 볼 기회가 없었다.
    expect(screen.getByTestId('send-error').textContent).toContain('1자 넘었다');
  });

  it('상한 안이면 그대로 나간다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" />);

    const body = '가'.repeat(MAX_MESSAGE_BODY_CHARS);
    const box = typeInto(body);
    // 누르기 전에 잰다 — 나간 뒤에는 초안이 비어 버튼이 (다른 이유로) 흐려진다.
    expect(sendButton().disabled).toBe(false);

    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith(body, []);
    expect(screen.queryByTestId('send-error')).toBeNull();
  });

  /**
   * 접두 멘션은 **발송 시점에 본문에 들어간다**(`Composer.tsx::send`). 그래서 사람이 친
   * 글자만 세면 화면은 여유가 있다고 보고 서버는 상한을 넘겼다고 거절한다 — 그 어긋남이
   * 바로 "보내지지도 않고 이유도 없는" 상태를 만드는 두 번째 길이다.
   */
  it('자동 멘션 접두까지 세어 막는다', () => {
    useAppStore.getState().set({ channelAutoMentions: { c1: [row('a1', 'fizz')] } });
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" autoMentionChannelId="c1" />);

    // 사람이 친 것은 상한과 딱 같다. 나갈 본문은 `@fizz ` 만큼 더 길다.
    typeInto('가'.repeat(MAX_MESSAGE_BODY_CHARS));

    expect(sendButton().disabled).toBe(true);
    expect(screen.getByTestId('body-count').textContent).toBe('6자 넘음');
  });

  it('남은 글자는 상한의 9할부터 보인다', () => {
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);

    typeInto('가'.repeat(Math.floor(MAX_MESSAGE_BODY_CHARS * 0.9) - 1));
    expect(screen.queryByTestId('body-count')).toBeNull();

    typeInto('가'.repeat(MAX_MESSAGE_BODY_CHARS - 100));
    expect(screen.getByTestId('body-count').textContent).toBe('100자 남음');
  });
});

describe('실패한 전송', () => {
  /** 결함 그 자체 — 이 하나가 무너지면 사람은 자기 글이 안 나갔다는 것을 모른다. */
  it('서버가 거절하면 사유를 남긴다', async () => {
    const onSend = vi.fn(() => Promise.reject(
      new ApiError(400, 'invalid_request', 'body: 글자 수가 상한을 넘었다'),
    ));
    render(<Composer onSend={onSend} scopeKey="c1" />);

    fireEvent.keyDown(typeInto('보낼 수 없는 글'), { key: 'Enter' });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId('send-error').textContent).toBe('body: 글자 수가 상한을 넘었다');
    // 초안 복원은 예전 규칙 그대로다 — 사유를 더한 것이 그것을 밀어내지 않는다.
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('보낼 수 없는 글');
  });

  it('사유를 못 받은 실패에도 침묵하지 않는다', async () => {
    const onSend = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    render(<Composer onSend={onSend} scopeKey="c1" />);

    fireEvent.keyDown(typeInto('연결이 끊긴 사이'), { key: 'Enter' });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId('send-error').textContent).toContain('나가지 않았다');
  });

  it('다시 눌러 성공하면 사유가 남지 않는다', async () => {
    const onSend = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new ApiError(500, 'internal', '서버가 죽었다')))
      .mockImplementationOnce(() => Promise.resolve());
    render(<Composer onSend={onSend} scopeKey="c1" />);

    fireEvent.keyDown(typeInto('한 번은 실패한다'), { key: 'Enter' });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('send-error')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByTestId('send-error')).toBeNull();
  });

  /**
   * 실패는 **글을 쓴 자리**의 사실이다. 초안 복원이 자리를 지키는 것과 같은 이유로 사유도
   * 자리를 지킨다 — 옮겨 온 채널에 남의 실패 사유가 서면 사람은 방금 자기가 누른 것이
   * 실패한 줄로 읽는다.
   */
  it('사유는 글을 쓴 자리에만 선다', async () => {
    const onSend = vi.fn(() => Promise.reject(new ApiError(403, 'channel_archived', '보관된 채널이다')));
    const { rerender } = render(<Composer onSend={onSend} scopeKey="c1" />);

    fireEvent.keyDown(typeInto('여기서 실패한다'), { key: 'Enter' });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('send-error')).toBeTruthy();

    rerender(<Composer onSend={onSend} scopeKey="c2" />);
    expect(screen.queryByTestId('send-error')).toBeNull();

    rerender(<Composer onSend={onSend} scopeKey="c1" />);
    expect(screen.getByTestId('send-error').textContent).toBe('보관된 채널이다');
  });
});
