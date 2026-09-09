import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller as ControllerType } from '../src/state/controller';
import { setExternalOpener } from '../src/lib/openExternal';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

/**
 * #724 — 코드 블록을 **드래그하지 않고** 복사할 수 있다.
 *
 * 이 파일이 지키는 것은 버튼이 있다는 사실이 아니라 **복사된 것이 원문이라는 것**이다.
 * 여기까지 오는 것은 여러 줄 명령이고, 한 글자·한 개행이 어긋난 `kubectl` 은 붙여넣어도
 * 실행되지 않는다 — 그런데 실패는 붙여넣는 순간에야 드러나므로, 화면에서 긁어 만든
 * 문자열이 클립보드로 가더라도 아무도 눈치채지 못한다. 그래서 값을 대조한다.
 *
 * 실패 경로에 회귀선을 하나 더 둔다: 클립보드가 막힌 환경(비보안 컨텍스트·권한 거부)에서
 * **조용히 아무 일도 일어나지 않으면** 사람은 복사됐다고 믿고 빈 클립보드를 붙여넣는다.
 */
const show = (body: string) =>
  render(<MessageItem message={msg('m1', 'c1', 1, body, 'u2')} />);

/** 클립보드를 갈아 끼운다. `undefined` 를 주면 **없는 환경**이 된다(비보안 컨텍스트). */
const setClipboard = (value: unknown) => {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true });
};

const FENCE = '```bash\nkubectl --context $CTX -n istio get certificate \\\n  -o yaml\nkubectl get pods\n```';
/** 위 펜스가 담고 있는 **원문**. 앞뒤 펜스 줄과 마지막 개행이 빠진 그것이다. */
const CODE = 'kubectl --context $CTX -n istio get certificate \\\n  -o yaml\nkubectl get pods';

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
  });
  setExternalOpener({ open: vi.fn(async () => undefined) });
  setController({ openMessage: vi.fn(async () => undefined) } as unknown as ControllerType);
});
afterEach(() => {
  cleanup();
  setExternalOpener(null);
  setController(null);
  setClipboard(undefined);
});

describe('코드 블록 복사 버튼', () => {
  it('버튼이 담는 것은 화면에서 긁은 글자가 아니라 펜스 안의 원문이다', async () => {
    const writeText = vi.fn(async () => undefined);
    setClipboard({ writeText });
    show(FENCE);

    screen.getByTestId('code-copy').click();

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODE));
  });

  /**
   * 버튼은 hover 로 숨기지 않는다. 이 버튼을 필요한 사람은 **있는 줄 몰라서 드래그하고
   * 있던 사람**이므로, 마우스를 올려야 나타나면 고친 것이 없다.
   */
  it('버튼은 마우스를 올리지 않아도 보인다', () => {
    setClipboard({ writeText: vi.fn(async () => undefined) });
    show(FENCE);

    const btn = screen.getByTestId('code-copy');
    expect(btn.className).not.toContain('opacity-0');
    expect(btn.className).not.toContain('group-hover');
  });

  /** 언어가 없는 펜스에도 버튼이 있다 — 헤더가 언어를 걸기 위한 자리가 아니게 됐다. */
  it('언어 표시가 없는 펜스에도 버튼이 있다', () => {
    setClipboard({ writeText: vi.fn(async () => undefined) });
    show('```\nls -al\n```');

    expect(screen.getByTestId('code-copy')).toBeTruthy();
    expect(screen.queryByTestId('code-lang')).toBeNull();
  });

  /**
   * 클립보드가 막혔을 때. **조용히 실패하지 않는다** — 사람에게 남은 길(선택해 뒀으니
   * ⌘C)을 알림으로 말한다. 이 줄이 없으면 실패는 붙여넣는 순간까지 숨는다.
   */
  it('클립보드가 없으면 알림으로 말한다 — 조용히 실패하지 않는다', async () => {
    setClipboard(undefined);
    show(FENCE);

    screen.getByTestId('code-copy').click();

    await waitFor(() => expect(useAppStore.getState().notice ?? '').not.toBe(''));
  });

  /** 눌린 것이 보여야 한다. 아무 변화가 없으면 사람은 한 번 더 누른다. */
  it('복사하면 버튼 글자가 바뀐다', async () => {
    setClipboard({ writeText: vi.fn(async () => undefined) });
    show(FENCE);

    const btn = screen.getByTestId('code-copy');
    const before = btn.textContent;
    btn.click();

    await waitFor(() => expect(screen.getByTestId('code-copy').textContent).not.toBe(before));
  });
});
