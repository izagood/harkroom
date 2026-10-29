import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { messagePermalink } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller as ControllerType } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { HostDocumentContext } from '../src/lib/hostDocument';
import { acc, msg } from './helpers/fakeApi';

/**
 * 새 창(채널·스레드 창)에서 복사하면 **그 창의** 클립보드로 쓴다(2026-10-29).
 *
 * 새 창은 메인 웹뷰가 포털로 그리므로, 전역 `navigator` 는 메인 창의 것이다. WebKit 은 부르는
 * 문서에 포커스가 없으면 쓰기를 `NotAllowedError` 로 거절하고, 새 창을 누른 순간 포커스는 새 창에
 * 있다 — 그래서 메인 창 것을 부르면 거의 늘 실패했다(「Could not copy the link」). 여기서는 메인
 * 클립보드를 그 거절처럼 만들어 두고, 새 창 클립보드에 들어가는지를 본다.
 */
function popupDoc(writeText: (text: string) => Promise<void>): Document {
  const doc = document.implementation.createHTMLDocument('popup');
  const nav = { clipboard: { writeText } };
  const view = new Proxy(window, {
    get: (target, key) => {
      if (key === 'navigator') return nav;
      const v = Reflect.get(target, key, target);
      return typeof v === 'function' && !/^[A-Z]/.test(String(key)) ? v.bind(target) : v;
    },
  });
  Object.defineProperty(doc, 'defaultView', { value: view });
  return doc;
}

function renderInPopup(doc: Document, body: string) {
  const container = doc.body.appendChild(doc.createElement('div'));
  return render(
    <HostDocumentContext.Provider value={doc}>
      <MessageItem message={msg('m9', 'c1', 5, body, 'u2')} />
    </HostDocumentContext.Provider>,
    { container },
  );
}

const mainWrite = vi.fn(async () => { throw new DOMException('not focused', 'NotAllowedError'); });

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
  });
  setController({ openMessage: vi.fn(async () => undefined) } as unknown as ControllerType);
  mainWrite.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: mainWrite }, configurable: true, writable: true });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('새 창에서 복사', () => {
  it('링크 복사는 새 창의 클립보드로 쓰고 실패 알림을 띄우지 않는다', async () => {
    const popupWrite = vi.fn(async () => undefined);
    const doc = popupDoc(popupWrite);
    const { container } = renderInPopup(doc, 'hello');

    fireEvent.click(within(container).getByTestId('toolbar-copy-link'));

    await waitFor(() => expect(popupWrite).toHaveBeenCalledWith(messagePermalink('m9')));
    expect(mainWrite).not.toHaveBeenCalled();
    expect(useAppStore.getState().notices).toEqual([]);
  });

  it('본문 복사도 새 창의 클립보드로 쓴다', async () => {
    const popupWrite = vi.fn(async () => undefined);
    const doc = popupDoc(popupWrite);
    const { container } = renderInPopup(doc, 'the decision stands');

    fireEvent.click(within(container).getByLabelText('More actions'));
    fireEvent.click(within(doc.body).getByRole('menuitem', { name: 'Copy text' }));

    await waitFor(() => expect(popupWrite).toHaveBeenCalledWith('the decision stands'));
    expect(mainWrite).not.toHaveBeenCalled();
  });

  it('코드 블록 복사도 새 창의 클립보드로 쓴다', async () => {
    const popupWrite = vi.fn(async () => undefined);
    const doc = popupDoc(popupWrite);
    const { container } = renderInPopup(doc, '```\nkubectl get pods\n```');

    fireEvent.click(within(container).getByTestId('code-copy'));

    await waitFor(() => expect(popupWrite).toHaveBeenCalledWith('kubectl get pods'));
    expect(mainWrite).not.toHaveBeenCalled();
  });

  it('새 창 클립보드도 막히면 실패 문구에 링크를 싣는다(번역 사전을 지난 문구)', async () => {
    const doc = popupDoc(async () => { throw new DOMException('denied', 'NotAllowedError'); });
    const { container } = renderInPopup(doc, 'hello');

    fireEvent.click(within(container).getByTestId('toolbar-copy-link'));

    await waitFor(() => expect(useAppStore.getState().notices.at(-1)?.text)
      .toBe(`Could not copy the link. Copy it by hand: ${messagePermalink('m9')}`));
  });
});
