import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { useNotificationOpen } from '../src/lib/useNotificationOpen';
import { NOTIFICATION_OPEN_EVENT } from '../src/lib/notify';

/**
 * 알림 클릭을 듣는 자리가 **앱 수명 전체**여야 한다는 것만 여기서 지킨다(#542).
 *
 * 화면이 어느 단계(`boot`/`connect`/`ready`)에 있든 알림은 온다 — 리스너를 `ready`
 * 안쪽에 두면 부팅 중에 누른 알림이 조용히 사라진다. 그리고 떼어낼 때 실제로 떼어야
 * 한다: 개발 모드 StrictMode 가 effect 를 두 번 실행하므로, 정리를 안 하면 리스너가
 * 둘 붙어 한 번의 클릭이 두 번 이동한다.
 */

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function fakeEventSurface() {
  let deliver: ((payload: unknown) => void) | undefined;
  const invoke = vi.fn<Invoke>(async (cmd) => (cmd === 'plugin:event|listen' ? 3 : undefined));
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (cb: (payload: unknown) => void) => { deliver = cb; return 1; },
  };
  return { invoke, emit: (payload: unknown) => deliver!({ payload }) };
}

afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

function Harness({ onOpen }: { onOpen: (t: { communityId: string; messageId: string }) => void }) {
  useNotificationOpen(onOpen);
  return null;
}

describe('알림 클릭 훅', () => {
  it('클릭된 알림의 목적지를 넘긴다', async () => {
    const surface = fakeEventSurface();
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);

    await waitFor(() => expect(surface.invoke).toHaveBeenCalledWith(
      'plugin:event|listen',
      expect.objectContaining({ event: NOTIFICATION_OPEN_EVENT }),
    ));
    surface.emit({ communityId: 'community-1', messageId: 'm1' });

    expect(onOpen).toHaveBeenCalledWith({ communityId: 'community-1', messageId: 'm1' });
  });

  it('언마운트하면 리스너를 떼어낸다', async () => {
    const surface = fakeEventSurface();
    const { unmount } = render(<Harness onOpen={vi.fn()} />);
    await waitFor(() => expect(surface.invoke).toHaveBeenCalledWith(
      'plugin:event|listen',
      expect.anything(),
    ));

    unmount();

    await waitFor(() => expect(surface.invoke).toHaveBeenCalledWith('plugin:event|unlisten', {
      event: NOTIFICATION_OPEN_EVENT,
      eventId: 3,
    }));
  });

  // 브라우저 개발에서는 이벤트 표면이 없다. 훅이 그 예외를 올려 보내면 앱 전체가 안 뜬다.
  it('Tauri 표면이 없는 환경에서도 앱을 막지 않는다', async () => {
    expect(() => render(<Harness onOpen={vi.fn()} />)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  // 콜백이 매 렌더 새 함수여도 리스너를 다시 붙이면, 그 사이에 온 클릭이 사라진다.
  it('콜백이 바뀌어도 리스너를 다시 붙이지 않는다', async () => {
    const surface = fakeEventSurface();
    const { rerender } = render(<Harness onOpen={vi.fn()} />);
    await waitFor(() => expect(surface.invoke).toHaveBeenCalledWith(
      'plugin:event|listen',
      expect.anything(),
    ));

    rerender(<Harness onOpen={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 0));

    const listens = surface.invoke.mock.calls.filter(([cmd]) => cmd === 'plugin:event|listen');
    expect(listens).toHaveLength(1);
  });
});
