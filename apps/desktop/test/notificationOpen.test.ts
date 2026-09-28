import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createNotifier,
  listenNotificationOpen,
  NOTIFICATION_OPEN_EVENT,
  NOTIFY_COMMAND,
  type NotificationTarget,
} from '../src/lib/notify';
import { resetCommunityRegistry, useCommunityRegistry } from '../src/state/communities';
import { openNotificationTarget, type Controller } from '../src/state/controller';
import { sessionStore } from '../src/lib/session';

/**
 * OS 알림을 눌렀을 때 **그 대화로** 가는 경로(#542).
 *
 * 왜 이 경로가 통째로 없었나: `tauri-plugin-notification` 의 데스크탑 구현(`desktop.rs`)은
 * `title/body/icon/sound` 만 `notify_rust` 로 넘기고 `extra`·`actionTypeId` 를 버린다.
 * JS 쪽 `onAction()` 이 듣는 `actionPerformed` 를 발신하는 코드는 `mobile.rs` 에만 있다 —
 * macOS 에서는 리스너를 붙여도 영원히 울리지 않는다. 지금 보이던 "포커스는 간다" 는
 * 플러그인이 `set_application(bundle_id)` 를 부른 결과 macOS 가 번들을 활성화한 것뿐이고,
 * 앱에는 아무 신호도 오지 않았다.
 *
 * 그래서 발신도 수신도 **우리 커맨드 하나**로 옮긴다. 여기서 지키는 것은 그 계약이다:
 * 목적지가 실려 나가는가, 돌아온 목적지가 그 커뮤니티의 그 메시지로 이어지는가.
 */

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function withTauri(internals: Record<string, unknown>): void {
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = internals;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('알림 발신 — 목적지를 함께 싣는다', () => {
  it('제목·본문과 목적지를 Rust 커맨드 하나로 넘긴다', async () => {
    const invoke = vi.fn<Invoke>(async () => undefined);
    withTauri({ invoke });

    await createNotifier().notify({
      title: '@bot posted in #general',
      body: '이것 좀 봐줘',
      target: { communityId: 'community-1', messageId: 'm1' },
    });

    expect(invoke).toHaveBeenCalledWith(NOTIFY_COMMAND, {
      title: '@bot posted in #general',
      body: '이것 좀 봐줘',
      target: { communityId: 'community-1', messageId: 'm1' },
    });
  });

  // 목적지 없는 알림은 여전히 성립한다 — 커맨드가 목적지를 옵셔널로 받는다는 계약이다.
  it('목적지가 없으면 null 로 넘긴다 — 자리를 비우지 않는다', async () => {
    const invoke = vi.fn<Invoke>(async () => undefined);
    withTauri({ invoke });

    await createNotifier().notify({ title: 't', body: 'b' });

    expect(invoke).toHaveBeenCalledWith(NOTIFY_COMMAND, { title: 't', body: 'b', target: null });
  });

  it('Tauri 표면이 없는 환경(브라우저 개발·테스트)에서는 조용히 넘긴다', async () => {
    await expect(createNotifier().notify({ title: 't', body: 'b' })).resolves.toBeUndefined();
  });

  it('커맨드가 실패해도 던지지 않는다 — 알림은 앱을 막지 않는다', async () => {
    withTauri({ invoke: vi.fn<Invoke>(async () => { throw new Error('no such command'); }) });

    await expect(createNotifier().notify({ title: 't', body: 'b' })).resolves.toBeUndefined();
  });
});

describe('알림 클릭 수신', () => {
  /** `plugin:event|listen` 을 stub 하고, Rust 가 이벤트를 쏘는 시점을 손에 쥔다. */
  function fakeEventSurface() {
    let deliver: ((payload: unknown) => void) | undefined;
    const invoke = vi.fn<Invoke>(async (cmd) => (cmd === 'plugin:event|listen' ? 7 : undefined));
    withTauri({
      invoke,
      transformCallback: (cb: (payload: unknown) => void) => { deliver = cb; return 1; },
    });
    return { invoke, emit: (payload: unknown) => deliver!({ payload }) };
  }

  it('이벤트의 목적지를 핸들러에게 준다', async () => {
    const surface = fakeEventSurface();
    const seen: NotificationTarget[] = [];

    await listenNotificationOpen((t) => seen.push(t));
    surface.emit({ communityId: 'community-2', messageId: 'm9' });

    expect(surface.invoke).toHaveBeenCalledWith('plugin:event|listen', expect.objectContaining({
      event: NOTIFICATION_OPEN_EVENT,
    }));
    expect(seen).toEqual([{ communityId: 'community-2', messageId: 'm9' }]);
  });

  // 목적지가 아닌 payload 를 그대로 흘리면 `openNotificationTarget` 이 undefined 로 이동을
  // 시도하고, 실패가 알림 클릭 자리에서 멀리 떨어진 곳에서 터진다.
  it('목적지 모양이 아닌 payload 는 흘리지 않는다', async () => {
    const surface = fakeEventSurface();
    const seen: NotificationTarget[] = [];

    await listenNotificationOpen((t) => seen.push(t));
    surface.emit({ messageId: 'm9' });
    surface.emit(null);
    surface.emit({ communityId: 'community-2' });

    expect(seen).toEqual([]);
  });

  it('떼어낸 뒤에는 unlisten 을 부른다', async () => {
    const surface = fakeEventSurface();

    const off = await listenNotificationOpen(() => {});
    await off();

    expect(surface.invoke).toHaveBeenCalledWith('plugin:event|unlisten', {
      event: NOTIFICATION_OPEN_EVENT,
      eventId: 7,
    });
  });

  it('Tauri 이벤트 표면이 없으면 던진다 — 조용히 안 듣는 상태를 만들지 않는다', async () => {
    await expect(listenNotificationOpen(() => {})).rejects.toThrow();
  });
});

describe('목적지로 이동한다', () => {
  const fakeController = () => ({ openMessage: vi.fn(async () => undefined) }) as unknown as Controller;

  beforeEach(() => {
    resetCommunityRegistry();
    vi.restoreAllMocks();
    // 커뮤니티 전환은 보관본의 `active` 도 옮긴다 — 키체인을 두드리지 않게 막는다.
    vi.spyOn(sessionStore, 'load').mockResolvedValue(null);
  });

  it('활성 커뮤니티의 알림이면 그 메시지를 연다', async () => {
    const registry = useCommunityRegistry.getState();
    const entry = registry.claimActive({ baseUrl: 'https://a.example', accountId: 'acct-a' });
    const controller = fakeController();
    useCommunityRegistry.getState().attachController(entry.id, controller);

    await openNotificationTarget({ communityId: entry.id, messageId: 'm1' });

    expect(controller.openMessage).toHaveBeenCalledWith('m1');
  });

  // 알림은 보고 있지 않은 커뮤니티에서도 온다. 화면을 옮기지 않고 메시지만 열면 그 메시지는
  // 지금 보이지 않는 스토어에 들어가고, 사용자는 아무 일도 안 난 것으로 본다.
  it('다른 커뮤니티의 알림이면 화면을 그 커뮤니티로 옮긴 뒤 연다', async () => {
    const registry = useCommunityRegistry.getState();
    const active = registry.claimActive({ baseUrl: 'https://a.example', accountId: 'acct-a' });
    const other = useCommunityRegistry.getState().register({ baseUrl: 'https://b.example', accountId: 'acct-b' });
    const controller = fakeController();
    useCommunityRegistry.getState().attachController(other.id, controller);

    await openNotificationTarget({ communityId: other.id, messageId: 'm2' });

    expect(useCommunityRegistry.getState().activeId).toBe(other.id);
    expect(controller.openMessage).toHaveBeenCalledWith('m2');
    expect(active.id).not.toBe(other.id);
  });

  // 알림을 보낸 뒤 그 커뮤니티를 이 기기에서 뺄 수 있다. 그때 id 는 아무것도 가리키지 않는다 —
  // `switchCommunity` 는 모르는 id 에 던지므로, 그 예외가 이벤트 핸들러에서 터지게 두지 않는다.
  it('그 사이 빠진 커뮤니티의 알림은 이동하지 않고 조용히 끝난다', async () => {
    const registry = useCommunityRegistry.getState();
    const entry = registry.claimActive({ baseUrl: 'https://a.example', accountId: 'acct-a' });

    await expect(openNotificationTarget({ communityId: 'community-does-not-exist', messageId: 'm3' }))
      .resolves.toBeUndefined();
    expect(useCommunityRegistry.getState().activeId).toBe(entry.id);
  });

  // 컨트롤러가 아직 안 꽂힌 순간이 실제로 있다(스토어는 만들었지만 세션이 안 붙은 엔트리).
  it('컨트롤러가 없는 커뮤니티면 전환까지만 하고 끝낸다', async () => {
    const registry = useCommunityRegistry.getState();
    registry.claimActive({ baseUrl: 'https://a.example', accountId: 'acct-a' });
    const other = useCommunityRegistry.getState().register({ baseUrl: 'https://b.example', accountId: 'acct-b' });

    await expect(openNotificationTarget({ communityId: other.id, messageId: 'm4' })).resolves.toBeUndefined();
    expect(useCommunityRegistry.getState().activeId).toBe(other.id);
  });
});
