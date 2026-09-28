import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { messagePermalink } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { ApiError } from '../src/lib/api';
import { Composer } from '../src/components/Composer';
import { Notice } from '../src/components/Notice';
import { MessageItem } from '../src/components/MessageItem';
import { acc, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

// #228 — 퍼머링크 고리의 **여는 쪽**. #178 이 링크를 만드는 쪽만 배선해서, 사용자가 얻는
// 것은 'Link copied.' 와 어디에도 쓸 수 없는 문자열이었다.
//
// 그 이동을 **붙여넣기 자체에 붙였던 것**을 여기서 되돌린다. 붙여넣으면 무조건 끌려갔으므로
// 링크를 채팅에 남길 방법이 아예 없었다 — "긴 스레드는 링크로 넘기고 새 스레드에서 잇자"가
// 못 되는 앱이었다. 그래서 이 파일이 지키는 것은 셋이다: 붙여넣기는 **글자를 남기고**,
// 이동은 **제안 줄의 버튼을 누를 때만** 일어나고, 그 밖의 붙여넣기는 건드리지 않는다.

const LINKED_ID = '11111111-2222-4333-8444-555555555555';

/**
 * 브라우저의 붙여넣기를 흉내낸다. jsdom 은 paste 의 **기본 동작(글자 삽입)을 하지 않으므로**
 * 이벤트만 쏘면 "가로채지 않았을 때 글자가 들어간다"를 아예 검증할 수 없다 — 무엇을 해도
 * 초안이 비어 있어 테스트가 늘 초록이 된다. 그래서 막히지 않았을 때만 삽입까지 해 준다.
 */
const paste = (box: HTMLElement, text: string): void => {
  const notPrevented = fireEvent.paste(box, { clipboardData: { getData: () => text } });
  if (!notPrevented) return;
  const next = (box as HTMLTextAreaElement).value + text;
  fireEvent.change(box, { target: { value: next, selectionStart: next.length } });
};

const draft = (): string => useAppStore.getState().drafts[''] ?? '';

/**
 * 제안 줄의 **이동** 버튼. 글자가 아니라 자리로 집는다 — 사전이 두 언어이므로 이름으로
 * 집으면 로케일 기본값이 바뀌는 날 테스트가 이유 없이 빨개진다.
 */
const goButton = (): HTMLElement =>
  screen.getByTestId('pasted-link').querySelectorAll('button')[0] as HTMLElement;
const dismissButton = (): HTMLElement =>
  screen.getByTestId('pasted-link').querySelectorAll('button')[1] as HTMLElement;

/** 컨트롤러를 세우고 돌려준다. 실제 Controller 를 쓰는 이유: 가로채기가 닿아야 하는 곳이 그것이다. */
const mount = (overrides = {}) => {
  const api = fakeApi(overrides);
  const { makeWs } = fakeWsFactory();
  const c = new Controller(api, makeWs);
  setController(c);
  return { api, c };
};

beforeEach(() => {
  useAppStore.getState().reset();
  // 초안은 저장소에 산다(#184). reset 은 메모리만 비우고 `start()` 가 저장소에서 다시
  // 채우므로, 지우지 않으면 앞 테스트가 남긴 초안이 다음 테스트에 되살아난다.
  useAppStore.getState().clearDrafts();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
  });
});
afterEach(() => {
  cleanup();
  setController(null as unknown as Controller);
});

describe('컴포저에 퍼머링크를 붙여넣는다', () => {
  const linked = () => msg(LINKED_ID, 'c1', 5, 'the decision we made', 'u2');

  it('링크만 붙여넣어도 글자는 초안에 남고, 저절로 이동하지 않는다', () => {
    const { api, c } = mount({
      message: vi.fn(async () => linked()),
      messages: vi.fn(async () => ({ messages: [linked()], hasMore: false })),
    });
    void c.start();
    render(<Composer onSend={vi.fn()} />);

    paste(screen.getByRole('textbox'), messagePermalink(LINKED_ID));

    // 이것이 요점이다 — 링크를 **채팅에 남기려는** 사람이 붙여넣기를 쓸 수 있어야 한다.
    expect(draft()).toBe(messagePermalink(LINKED_ID));
    expect(api.message).not.toHaveBeenCalled();
    expect(useAppStore.getState().activeChannelId).toBeNull();
  });

  it('제안 줄의 버튼을 누르면 그 메시지가 열린다', async () => {
    const { api, c } = mount({
      message: vi.fn(async () => linked()),
      messages: vi.fn(async () => ({ messages: [linked()], hasMore: false })),
    });
    await c.start();
    render(<Composer onSend={vi.fn()} />);

    paste(screen.getByRole('textbox'), messagePermalink(LINKED_ID));
    fireEvent.click(goButton());

    await waitFor(() => expect(useAppStore.getState().activeChannelId).toBe('c1'));
    expect(api.message).toHaveBeenCalledWith(LINKED_ID);
    // 열기만 하고 어느 것인지 안 보이면 긴 채널에서는 아무 일도 안 일어난 것과 같다.
    expect(useAppStore.getState().highlightedMessageId).toBe(LINKED_ID);
  });

  it('이동해도 붙여넣은 글자는 그 자리의 초안에 남는다', async () => {
    const { c } = mount({
      message: vi.fn(async () => linked()),
      messages: vi.fn(async () => ({ messages: [linked()], hasMore: false })),
    });
    await c.start();
    render(<Composer onSend={vi.fn()} />);

    paste(screen.getByRole('textbox'), messagePermalink(LINKED_ID));
    fireEvent.click(goButton());

    await waitFor(() => expect(useAppStore.getState().activeChannelId).toBe('c1'));
    // 이동은 링크를 **소비하지 않는다** — 갔다 와서 그 링크를 인용해 쓸 수도 있다.
    expect(draft()).toBe(messagePermalink(LINKED_ID));
  });

  it('붙여넣은 링크를 지우면 제안 줄도 사라진다', () => {
    const { c } = mount();
    void c.start();
    render(<Composer onSend={vi.fn()} />);
    const box = screen.getByRole('textbox');

    paste(box, messagePermalink(LINKED_ID));
    expect(screen.getByTestId('pasted-link')).toBeTruthy();

    fireEvent.change(box, { target: { value: '', selectionStart: 0 } });

    // 초안에 없는 것을 가리키는 버튼이 남으면, 누른 사람은 방금 붙여넣은 것으로 읽는다.
    expect(screen.queryByTestId('pasted-link')).toBeNull();
  });

  it('제안 줄을 닫으면 이동하지 않고 글자만 남는다', () => {
    const { api, c } = mount({ message: vi.fn(async () => linked()) });
    void c.start();
    render(<Composer onSend={vi.fn()} />);

    paste(screen.getByRole('textbox'), messagePermalink(LINKED_ID));
    fireEvent.click(dismissButton());

    expect(screen.queryByTestId('pasted-link')).toBeNull();
    expect(draft()).toBe(messagePermalink(LINKED_ID));
    expect(api.message).not.toHaveBeenCalled();
  });

  it('문장 속에 섞인 링크는 가로채지 않고 평범하게 들어간다', async () => {
    const { api, c } = mount();
    await c.start();
    render(<Composer onSend={vi.fn()} />);
    const quoted = `이거 봐 ${messagePermalink(LINKED_ID)} 여기서 정했어`;

    paste(screen.getByRole('textbox'), quoted);

    // 인용하려는 사람을 끌고 가면 쓰던 글을 잃는다.
    expect(draft()).toBe(quoted);
    expect(api.message).not.toHaveBeenCalled();
    expect(useAppStore.getState().activeChannelId).toBeNull();
    // 문장째 붙여넣은 것은 애초에 인용이다 — 제안 줄도 세우지 않는다.
    expect(screen.queryByTestId('pasted-link')).toBeNull();
  });

  it('퍼머링크가 아닌 텍스트는 평범하게 들어간다', async () => {
    const { api, c } = mount();
    await c.start();
    render(<Composer onSend={vi.fn()} />);

    paste(screen.getByRole('textbox'), 'https://example.com/notes 를 봐');

    expect(draft()).toBe('https://example.com/notes 를 봐');
    expect(api.message).not.toHaveBeenCalled();
  });

  it('볼 수 없는 메시지의 링크를 붙여넣으면 오류가 화면에 보인다', async () => {
    const { c } = mount({
      message: vi.fn(async () => { throw new ApiError(403, 'forbidden', 'not a member of this dm channel'); }),
    });
    await c.start();
    render(<><Composer onSend={vi.fn()} /><Notice /></>);

    paste(screen.getByRole('textbox'), messagePermalink(LINKED_ID));
    fireEvent.click(goButton());

    // 조용히 아무 일도 안 하면 누른 사람은 앱이 멈춘 줄 알고 같은 버튼을 계속 누른다.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/can't open that message/i);
    expect(useAppStore.getState().activeChannelId).toBeNull();
  });

  it('사라진 메시지의 링크를 붙여넣으면 오류가 화면에 보인다', async () => {
    const { c } = mount({
      message: vi.fn(async () => { throw new ApiError(404, 'not_found', 'no such message'); }),
    });
    await c.start();
    render(<><Composer onSend={vi.fn()} /><Notice /></>);

    paste(screen.getByRole('textbox'), messagePermalink(LINKED_ID));
    fireEvent.click(goButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/gone/i);
    expect(useAppStore.getState().activeChannelId).toBeNull();
  });

  // #397 — 스레드를 닫으면 강조도 해제된다.
  it('스레드를 닫으면 강조가 사라진다', async () => {
    const { c } = mount({
      message: vi.fn(async () => linked()),
      messages: vi.fn(async () => ({ messages: [linked()], hasMore: false })),
    });
    await c.start();
    render(<Composer onSend={vi.fn()} />);

    paste(screen.getByRole('textbox'), messagePermalink(LINKED_ID));
    fireEvent.click(goButton());

    await waitFor(() => expect(useAppStore.getState().highlightedMessageId).toBe(LINKED_ID));

    c.closeThread();

    expect(useAppStore.getState().highlightedMessageId).toBeNull();
  });

  // #397 — 시간 기반 해제. 강조가 영원히 남으면 같은 채널에서 다음 강조가 신호를 잃는다.
  // 되돌려 RED 로 확인한 결과 이 경로를 지키는 회귀선이 없었으므로 여기서 고정한다.
  it('일정 시간이 지나면 강조가 저절로 사라진다', () => {
    vi.useFakeTimers();
    try {
      useAppStore.getState().set({ highlightedMessageId: LINKED_ID });
      render(<MessageItem message={linked()} />);

      expect(useAppStore.getState().highlightedMessageId).toBe(LINKED_ID);

      vi.advanceTimersByTime(5000);

      expect(useAppStore.getState().highlightedMessageId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // #397 — 해제는 **자기 강조만** 지운다. 타이머가 도는 사이 강조가 다른 메시지로 옮겨가면
  // 그 강조는 건드리지 않는다. 이 구분이 없으면 퍼머링크로 방금 건 강조를 남의 타이머가 지운다.
  it('타이머는 다른 메시지로 옮겨간 강조를 지우지 않는다', () => {
    vi.useFakeTimers();
    try {
      const OTHER_ID = '99999999-2222-4333-8444-555555555555';
      useAppStore.getState().set({ highlightedMessageId: LINKED_ID });
      render(<MessageItem message={linked()} />);

      // 타이머가 만료되기 전에 강조가 다른 메시지로 옮겨간다.
      useAppStore.getState().set({ highlightedMessageId: OTHER_ID });
      vi.advanceTimersByTime(5000);

      expect(useAppStore.getState().highlightedMessageId).toBe(OTHER_ID);
    } finally {
      vi.useRealTimers();
    }
  });
});
