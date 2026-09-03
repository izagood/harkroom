import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { messagePermalink } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { Controller, setController } from '../src/state/controller';
import { ApiError } from '../src/lib/api';
import { Composer } from '../src/components/Composer';
import { Notice } from '../src/components/Notice';
import { acc, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

// #228 — 퍼머링크 고리의 **여는 쪽**. #178 이 링크를 만드는 쪽만 배선해서, 사용자가 얻는
// 것은 'Link copied.' 와 어디에도 쓸 수 없는 문자열이었다. 여기서 지키는 것은 두 가지다:
// 링크만 붙여넣으면 그 메시지가 열린다는 것, 그리고 **그 밖의 붙여넣기는 건드리지 않는다**는
// 것. 후자를 놓치면 링크를 인용하려던 사람이 쓰던 글을 잃는다.

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

  it('링크만 붙여넣으면 그 메시지가 열린다', async () => {
    const { api, c } = mount({
      message: vi.fn(async () => linked()),
      messages: vi.fn(async () => ({ messages: [linked()], hasMore: false })),
    });
    await c.start();
    render(<Composer onSend={vi.fn()} />);

    paste(screen.getByRole('textbox'), messagePermalink(LINKED_ID));

    await waitFor(() => expect(useAppStore.getState().activeChannelId).toBe('c1'));
    expect(api.message).toHaveBeenCalledWith(LINKED_ID);
    // 열기만 하고 어느 것인지 안 보이면 긴 채널에서는 아무 일도 안 일어난 것과 같다.
    expect(useAppStore.getState().highlightedMessageId).toBe(LINKED_ID);
  });

  it('가로챈 링크는 초안에 남지 않는다', async () => {
    const { c } = mount({
      message: vi.fn(async () => linked()),
      messages: vi.fn(async () => ({ messages: [linked()], hasMore: false })),
    });
    await c.start();
    render(<Composer onSend={vi.fn()} />);

    paste(screen.getByRole('textbox'), messagePermalink(LINKED_ID));

    await waitFor(() => expect(useAppStore.getState().activeChannelId).toBe('c1'));
    // 이동하면서 글자가 남으면 초안이 더러워지고, 다음에 쓴 문장에 링크가 붙어 나간다.
    expect(draft()).toBe('');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
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

    // 조용히 아무 일도 안 하면 붙여넣은 사람은 앱이 멈춘 줄 알고 같은 링크를 계속 붙여넣는다.
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

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/gone/i);
    expect(useAppStore.getState().activeChannelId).toBeNull();
  });
});
