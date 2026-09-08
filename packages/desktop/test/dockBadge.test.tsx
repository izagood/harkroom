import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';
import type { InboxEntry } from '@murmur/shared';
import { useCommunityRegistry, resetCommunityRegistry, useActiveStore as useAppStore } from '../src/state/communities';
import { useDockBadge, resetDockBadgeForTest } from '../src/lib/useDockBadge';
import { createBadger, BADGE_COUNT_COMMAND, BADGE_LABEL_COMMAND, BADGE_DOT_LABEL, type Badge } from '../src/lib/badge';
// 권한 파일을 **이 파일 기준**으로 끌어온다(`?raw`) — `titlebar.test.tsx` 와 같은 관례다.
import capabilitiesRaw from '../src-tauri/capabilities/default.json?raw';

/**
 * 독(Dock) 배지 — 신고: *"새로운 알림이 왔는데 Slack 앱처럼 알림 표시가 없다."*
 *
 * 이 파일이 잠그는 계약은 셋이다.
 * 1. **화면과 같은 것을 센다**: 안 읽은 멘션·DM(`state/unread.ts`). 스레드 답글이나
 *    이미 읽은 항목이 숫자에 섞이면 배지가 늘 켜져 있어 아무 말도 하지 않게 된다.
 * 2. **커뮤니티를 합친다**: 독 아이콘은 하나뿐이라, 활성 커뮤니티만 세면 다른 커뮤니티의
 *    멘션이 어디에도 남지 않는다.
 * 3. **숫자가 없으면 점**: 멘션은 없지만 새 대화가 있는 상태를 독이 말할 수 있어야 한다
 *    (사이드바의 회색 점과 같은 뜻).
 */

const entry = (id: number, reason: InboxEntry['reason'] = 'mention', readAt: string | null = null): InboxEntry => ({
  id, messageId: `m${id}`, reason, readAt, channelId: 'c1', authorId: 'u1',
  body: '', meta: {}, createdAt: '2026-09-08T00:00:00.000Z', threadRootId: null,
});

function fakeBadger() {
  const applied: Badge[] = [];
  return { applied, set: vi.fn(async (b: Badge) => { applied.push(b); }), last: () => applied.at(-1) };
}

function Harness({ badger }: { badger: { set: (b: Badge) => Promise<void> } }) {
  useDockBadge(badger);
  return null;
}

beforeEach(() => {
  resetCommunityRegistry();
  resetDockBadgeForTest();
});

afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('독 배지', () => {
  it('안 읽은 멘션·DM 만 센다', async () => {
    const badger = fakeBadger();
    render(<Harness badger={badger} />);

    act(() => {
      useAppStore.getState().set({
        unread: [entry(1, 'mention'), entry(2, 'dm'), entry(3, 'thread_reply'), entry(4, 'mention', '2026-09-08T01:00:00.000Z')],
      });
    });

    await waitFor(() => expect(badger.last()).toEqual({ count: 2, dot: false }));
  });

  it('커뮤니티 전부를 합친다 — 활성 커뮤니티만 세지 않는다', async () => {
    const badger = fakeBadger();
    const second = useCommunityRegistry.getState().register({ baseUrl: 'https://b.example' });
    render(<Harness badger={badger} />);

    act(() => {
      useAppStore.getState().set({ unread: [entry(1, 'mention')] });
      second.store.getState().set({ unread: [entry(2, 'mention'), entry(3, 'dm')] });
    });

    await waitFor(() => expect(badger.last()).toEqual({ count: 3, dot: false }));
  });

  it('멘션이 없고 안 읽은 대화만 있으면 점을 찍는다', async () => {
    const badger = fakeBadger();
    render(<Harness badger={badger} />);

    act(() => {
      useAppStore.getState().set({ reads: { c1: { lastReadSeq: 3, unread: 2 } } });
    });

    await waitFor(() => expect(badger.last()).toEqual({ count: 0, dot: true }));
  });

  it('숫자가 있으면 점은 찍지 않는다 — 자리가 하나다', async () => {
    const badger = fakeBadger();
    render(<Harness badger={badger} />);

    act(() => {
      useAppStore.getState().set({
        unread: [entry(1, 'mention')],
        reads: { c1: { lastReadSeq: 3, unread: 2 } },
      });
    });

    await waitFor(() => expect(badger.last()).toEqual({ count: 1, dot: false }));
  });

  it('다 읽으면 배지를 지운다', async () => {
    const badger = fakeBadger();
    render(<Harness badger={badger} />);

    act(() => { useAppStore.getState().set({ unread: [entry(1, 'mention')] }); });
    await waitFor(() => expect(badger.last()).toEqual({ count: 1, dot: false }));

    act(() => { useAppStore.getState().set({ unread: [] }); });
    await waitFor(() => expect(badger.last()).toEqual({ count: 0, dot: false }));
  });
});

describe('배지 표면', () => {
  /** Tauri 커맨드 표면. 라벨은 `getCurrentWindow()` 가 읽는 자리와 같은 곳에서 온다. */
  function fakeTauri() {
    const invoke = vi.fn(async () => undefined);
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke, metadata: { currentWindow: { label: 'main' } },
    };
    return invoke;
  }

  it('숫자를 세울 때는 값을 그대로 넘긴다', async () => {
    const invoke = fakeTauri();
    await createBadger().set({ count: 4, dot: false });
    expect(invoke).toHaveBeenCalledWith(BADGE_COUNT_COMMAND, { label: 'main', value: 4 });
  });

  it('점은 라벨 커맨드로 찍는다', async () => {
    const invoke = fakeTauri();
    await createBadger().set({ count: 0, dot: true });
    expect(invoke).toHaveBeenCalledWith(BADGE_COUNT_COMMAND, { label: 'main', value: null });
    expect(invoke).toHaveBeenCalledWith(BADGE_LABEL_COMMAND, { label: 'main', value: BADGE_DOT_LABEL });
  });

  it('빈 배지는 숫자와 라벨을 모두 지운다', async () => {
    const invoke = fakeTauri();
    await createBadger().set({ count: 0, dot: false });
    expect(invoke).toHaveBeenCalledWith(BADGE_COUNT_COMMAND, { label: 'main', value: null });
    expect(invoke).toHaveBeenCalledWith(BADGE_LABEL_COMMAND, { label: 'main', value: null });
  });

  it('같은 값을 두 번 쓰지 않는다 — 스토어 변화마다 IPC 를 왕복하지 않는다', async () => {
    const invoke = fakeTauri();
    const badger = createBadger();
    await badger.set({ count: 2, dot: false });
    await badger.set({ count: 2, dot: false });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('표면이 없는 환경에서는 조용히 넘긴다', async () => {
    // 브라우저 dev 모드. 던지면 배지 하나 때문에 앱이 멈춘다.
    await expect(createBadger().set({ count: 1, dot: false })).resolves.toBeUndefined();
  });

  it('커맨드가 거절해도 던지지 않고, 다음 변화에서 다시 시도한다', async () => {
    const invoke = vi.fn(async () => { throw new Error('not allowed'); });
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke, metadata: { currentWindow: { label: 'main' } },
    };
    const badger = createBadger();
    await badger.set({ count: 1, dot: false });
    await badger.set({ count: 1, dot: false });
    // 실패한 값은 "적용됐다"고 기억하지 않는다 — 그러면 권한이 열린 뒤에도 배지가 안 뜬다.
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

/**
 * 권한(ACL)은 **런타임에만** 걸린다 — 위 블록들이 전부 초록이어도 이 두 줄이 없으면
 * 배지는 앱에서 죽어 있다(호출이 권한 오류로 거절되고, `createBadger` 의 `catch` 가 그것을
 * 삼킨다). 그래서 결정을 갖고 있는 파일을 직접 읽는다 — `titlebar.test.tsx` 의
 * `core:window:allow-start-dragging` 단언과 같은 이유다.
 */
describe('배지 권한', () => {
  const names = (JSON.parse(capabilitiesRaw) as { permissions: (string | { identifier: string })[] })
    .permissions.map((p) => (typeof p === 'string' ? p : p.identifier));

  it('capabilities 가 배지 커맨드를 허용한다', () => {
    expect(names).toContain('core:window:allow-set-badge-count');
    // macOS 의 점(라벨)은 별도 권한이다 — 숫자만 열면 점이 조용히 사라진다.
    expect(names).toContain('core:window:allow-set-badge-label');
  });

  it('그 권한이 배지를 세우는 창(main)에 걸려 있다', () => {
    // `createBadger` 는 창 라벨을 `__TAURI_INTERNALS__` 에서 읽고, 없으면 `main` 으로
    // 떨어진다. 그 라벨이 이 목록에 없으면 권한을 줘도 닿지 않는다.
    const caps = JSON.parse(capabilitiesRaw) as { windows: string[] };
    expect(caps.windows).toContain('main');
  });
});
