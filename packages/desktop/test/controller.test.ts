import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../src/state/appStore';
import { Controller } from '../src/state/controller';
import { acc, accountsResult, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

beforeEach(() => useAppStore.getState().reset());

describe('Controller', () => {
  it('start loads directory data and connects ws', async () => {
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs);
    await c.start();
    const s = useAppStore.getState();
    expect(s.me?.handle).toBe('admin');
    expect(s.channels).toHaveLength(1);
    expect(Object.keys(s.accounts)).toHaveLength(2);
    callbacks.current!.onOpen();
    expect(useAppStore.getState().connected).toBe(true);
  });

  it('openChannel fetches since maxSeq and marks channel inbox read', async () => {
    const api = fakeApi({
      messages: vi.fn(async () => ({ messages: [msg('m1', 'c1', 1, 'a'), msg('m2', 'c1', 2, 'b')], hasMore: false })),
      inboxUnread: vi.fn(async () => [
        // as const 없이는 reason 이 string 으로 추론돼 InboxEntry 의 union 과 어긋난다.
        { id: 7, messageId: 'm1', reason: 'mention' as const, readAt: null, channelId: 'c1' },
      ]),
    });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    await c.openChannel('c1');
    const s = useAppStore.getState();
    expect(s.activeChannelId).toBe('c1');
    expect(s.messages.c1).toHaveLength(2);
    expect((api.markRead as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual([7]);
  });

  // 투영된 system 메시지는 사용자가 그 채널을 보고 있지 않아도 WS로 들어온다. 그때 maxSeq가
  // 올라가 버리면, 채널을 처음 열 때의 증분 조회가 backlog 전체를 건너뛴다.
  it('loads full history the first time a channel opens, even if live messages arrived first', async () => {
    const history = [msg('m1', 'c1', 1, '오래된 대화'), msg('m2', 'c1', 2, '그 다음 대화')];
    const api = fakeApi({ messages: vi.fn(async () => ({ messages: history, hasMore: false })) });
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();

    // 채널을 열지 않은 상태에서 실시간 메시지가 먼저 도착한다 (투영 system 메시지가 그렇다).
    callbacks.current!.onEvent({
      type: 'message.created',
      message: msg('m14', 'c1', 14, '투영된 intent'),
      audience: 'all',
    });

    await c.openChannel('c1');

    const since = (api.messages as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(since).toMatchObject({ since: 0 });
    expect(useAppStore.getState().messages.c1!.map((m) => m.id)).toEqual(['m1', 'm2', 'm14']);
  });

  it('reopening an already loaded channel fetches only what is new', async () => {
    const api = fakeApi({ messages: vi.fn(async () => ({ messages: [msg('m1', 'c1', 5, 'first load')], hasMore: false })) });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();

    await c.openChannel('c1');
    await c.openChannel('c1');

    const since = (api.messages as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(since).toMatchObject({ since: 5 });
  });

  // 서버는 기동 시 투영용 system 계정을 만든다. 그보다 먼저 부트스트랩한 클라이언트는 그 계정을
  // 모르므로, 작성자를 모르는 메시지가 오면 디렉터리를 다시 받아야 한다.
  it('refetches the account directory when a message arrives from an unknown author', async () => {
    const api = fakeApi();
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    // 캐스트가 타입 검사를 우회하므로 **모양을 손으로 맞춰야 한다.** #230 이 `accounts()`
    // 를 `{ accounts, groups }` 로 바꿨고, 배열을 그대로 두면 tsc 는 통과하지만 런타임에
    // `accounts` 가 undefined 가 되어 디렉터리 갱신이 조용히 사라진다.
    (api.accounts as ReturnType<typeof vi.fn>).mockResolvedValue(accountsResult([
      acc('u1', 'admin'), acc('u2', 'bot', 'agent'), acc('sys', 'murmur', 'agent'),
    ]));

    callbacks.current!.onEvent({
      type: 'message.created',
      message: msg('m20', 'c1', 20, '@jaebin intent: 무언가', 'sys', { kind: 'system' }),
      audience: 'all',
    });
    await vi.waitFor(() => expect(useAppStore.getState().accounts.sys).toBeDefined());

    expect(useAppStore.getState().accounts.sys!.handle).toBe('murmur');
  });

  it('does not refetch the directory for a message from a known author', async () => {
    const api = fakeApi();
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    const before = (api.accounts as ReturnType<typeof vi.fn>).mock.calls.length;

    callbacks.current!.onEvent({
      type: 'message.created',
      message: msg('m21', 'c1', 21, '아는 사람', 'u2'),
      audience: 'all',
    });
    await Promise.resolve();

    expect((api.accounts as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(before);
  });

  it('ws message.created upserts without duplicates; reconcile refetches on reopen', async () => {
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs);
    await c.start();
    await c.openChannel('c1');
    const m = msg('m9', 'c1', 9, 'live');
    callbacks.current!.onEvent({ type: 'message.created', message: m, audience: 'all' });
    callbacks.current!.onEvent({ type: 'message.created', message: m, audience: 'all' });
    expect(useAppStore.getState().messages.c1!.filter((x) => x.id === 'm9')).toHaveLength(1);
  });

  it('applies message.updated in place', async () => {
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs);
    await c.start();
    await c.openChannel('c1');
    const original = msg('m5', 'c1', 5, '고치기 전');
    callbacks.current!.onEvent({ type: 'message.created', message: original, audience: 'all' });

    callbacks.current!.onEvent({
      type: 'message.updated',
      message: { ...original, body: '고친 뒤', editedAt: new Date().toISOString() },
      audience: 'all',
    });

    const row = useAppStore.getState().messages.c1!.find((m) => m.id === 'm5')!;
    expect(row.body).toBe('고친 뒤');
    expect(row.editedAt).not.toBeNull();
  });

  it('drops a message on message.deleted', async () => {
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs);
    await c.start();
    await c.openChannel('c1');
    callbacks.current!.onEvent({ type: 'message.created', message: msg('m6', 'c1', 6, '지울 것'), audience: 'all' });

    callbacks.current!.onEvent({ type: 'message.deleted', channelId: 'c1', messageId: 'm6', audience: 'all' });

    expect(useAppStore.getState().messages.c1!.map((m) => m.id)).not.toContain('m6');
  });

  it('edit sends the new body and drops the message on delete', async () => {
    const api = fakeApi();
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    await c.openChannel('c1');

    await c.editMessage('m1', '새 본문');
    await c.deleteMessage('m1');

    expect((api.editMessage as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['c1', 'm1', '새 본문']);
    expect((api.deleteMessage as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['c1', 'm1']);
  });

  // 최신 창 밖으로 밀려난 대화에 도달할 경로가 필요하다.
  it('loads an older page from the oldest message it holds', async () => {
    const api = fakeApi({
      messages: vi.fn(async (_c: string, opts?: { before?: number }) =>
        (opts?.before
          ? { messages: [msg('m1', 'c1', 1, '더 오래된 것')], hasMore: false }
          : { messages: [msg('m9', 'c1', 9, '최신')], hasMore: true }) as never),
    });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    await c.openChannel('c1');
    expect(useAppStore.getState().hasMore.c1).toBe(true);

    await c.loadOlder();

    const call = (api.messages as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(call[1]).toMatchObject({ before: 9 });
    expect(useAppStore.getState().messages.c1!.map((m) => m.id)).toEqual(['m1', 'm9']);
    expect(useAppStore.getState().hasMore.c1).toBe(false);
  });

  it('does not ask for an older page when none remain', async () => {
    const api = fakeApi({
      messages: vi.fn(async () => ({ messages: [msg('m1', 'c1', 1, '전부')], hasMore: false }) as never),
    });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    await c.openChannel('c1');
    const before = (api.messages as ReturnType<typeof vi.fn>).mock.calls.length;

    await c.loadOlder();

    expect((api.messages as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(before);
  });

  it('presence events update online list', async () => {
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs);
    await c.start();
    callbacks.current!.onEvent({ type: 'presence.snapshot', online: ['u1'] });
    callbacks.current!.onEvent({ type: 'presence.changed', accountId: 'u2', online: true });
    expect(useAppStore.getState().online.sort()).toEqual(['u1', 'u2']);
    callbacks.current!.onEvent({ type: 'presence.changed', accountId: 'u1', online: false });
    expect(useAppStore.getState().online).toEqual(['u2']);
  });

  it('refreshUnread ignores a stale response that arrives after a newer one', async () => {
    const entries2 = [{ id: 2, messageId: 'm2', reason: 'mention' as const, readAt: null, channelId: 'c1' }];
    let resolveStale: ((v: typeof entries2) => void) | null = null;
    let call = 0;
    const api = fakeApi({
      inboxUnread: vi.fn(() => {
        call += 1;
        if (call === 1) return Promise.resolve([]); // start()의 초기 로드
        if (call === 2) return new Promise<typeof entries2>((resolve) => { resolveStale = resolve; }); // 먼저 발행, 나중에 도착
        return Promise.resolve(entries2); // 나중에 발행, 먼저 도착
      }),
    });
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();

    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' }); // call #2 — 응답 지연
    callbacks.current!.onEvent({ type: 'inbox.updated', accountId: 'u1' }); // call #3 — 즉시 resolve
    await Promise.resolve();
    await Promise.resolve();
    expect(useAppStore.getState().unread).toEqual(entries2);

    resolveStale!([{ id: 1, messageId: 'm1', reason: 'mention', readAt: null, channelId: 'c1' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(useAppStore.getState().unread).toEqual(entries2); // stale 응답이 최신 값을 덮지 않는다
  });

  it('send posts to active channel with idempotency key', async () => {
    const api = fakeApi();
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    await c.openChannel('c1');
    await c.send('hello');
    const call = (api.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('c1');
    expect(call[1]).toBe('hello');
    expect(typeof call[3]).toBe('string'); // idempotency key
  });

  // 지금까지 logout 은 로컬 토큰만 지웠고 서버 세션은 TTL(14일)을 그대로 살았다. 로그아웃은
  // 서버에서도 폐기여야 한다 — 그리고 그 호출이 실패해도 로컬은 반드시 비워야 한다
  // (실패로 로그인 상태에 갇히면 사용자가 나갈 방법이 없다).
  it('revokes the server session on logout and clears local state even when that call fails', async () => {
    const api = fakeApi({ logout: vi.fn(async () => { throw new Error('offline'); }) });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    localStorage.setItem('murmur.session', JSON.stringify({ baseUrl: 'http://x', token: 't' }));

    c.logout();
    await vi.waitFor(() => expect(api.logout).toHaveBeenCalled());

    expect(localStorage.getItem('murmur.session')).toBeNull();
    expect(useAppStore.getState().me).toBeNull();
  });

  // 세션이 죽었는데 "연결 끊김"만 표시하면 사용자는 영구 재연결만 본다. 로컬 상태를 비우고
  // 사유를 위로 올려 로그인 화면이 이유를 말할 수 있게 해야 한다.
  it('clears the session and reports why when the credential is gone', async () => {
    const lost: string[] = [];
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs, undefined, (msg) => lost.push(msg));
    await c.start();
    localStorage.setItem('murmur.session', JSON.stringify({ baseUrl: 'http://x', token: 't' }));

    callbacks.current!.onDown('credential');

    expect(localStorage.getItem('murmur.session')).toBeNull();
    expect(useAppStore.getState().me).toBeNull();
    expect(lost).toHaveLength(1);
    expect(lost[0]!.toLowerCase()).toContain('sign in');
  });

  // #164: App 은 이 accountId 로 **활성 커뮤니티인지**를 가른다. clearLocal() 이 스토어를
  // reset 하므로 그 뒤에 me 를 읽으면 항상 빈 문자열이 되고, 활성 커뮤니티가 죽어도
  // 화면이 바뀌지 않는다 — 순서가 계약이다.
  it('세션 손실을 알릴 때 비어 있지 않은 accountId 를 넘긴다', async () => {
    const got: { msg: string; accountId: string }[] = [];
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs, undefined, (msg, accountId) => got.push({ msg, accountId }));
    await c.start();
    expect(useAppStore.getState().me?.id).toBeTruthy();

    callbacks.current!.onDown('credential');

    expect(got).toHaveLength(1);
    expect(got[0]!.accountId).toBeTruthy();
    expect(got[0]!.accountId).toBe('u1');
  });

  it('reports an origin rejection with its own wording', async () => {
    const lost: string[] = [];
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs, undefined, (msg) => lost.push(msg));
    await c.start();

    callbacks.current!.onDown('origin');

    expect(lost).toHaveLength(1);
    expect(lost[0]!.toLowerCase()).toContain('origin');
  });

  // 네트워크 끊김은 세션을 건드리면 안 된다 — 잠깐 끊겼다고 로그아웃시키면 최악이다.
  it('keeps the session on an ordinary disconnect', async () => {
    const lost: string[] = [];
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs, undefined, (msg) => lost.push(msg));
    await c.start();
    localStorage.setItem('murmur.session', JSON.stringify({ baseUrl: 'http://x', token: 't' }));

    callbacks.current!.onDown('network');

    expect(useAppStore.getState().connected).toBe(false);
    expect(localStorage.getItem('murmur.session')).not.toBeNull();
    expect(useAppStore.getState().me).not.toBeNull();
    expect(lost).toEqual([]);
  });

  // 자격증명이 죽은 상태로 서버에 로그아웃을 보내는 것은 무의미하다(401 로 끝난다).
  it('does not call the logout endpoint when the credential is already dead', async () => {
    const api = fakeApi();
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs, undefined, () => {});
    await c.start();

    callbacks.current!.onDown('credential');

    expect(api.logout).not.toHaveBeenCalled();
  });

  // 자동완성을 짧은 간격으로 여러 번 열어도 디렉터리 요청이 한 번만 나가게 한다.
  // 최소 간격 가드는 5초다.
  it('refreshAccounts throttles rapid calls within 5 seconds', async () => {
    const accountsCalls = vi.fn(async () => accountsResult([acc('u1', 'admin')]));
    const api = fakeApi({ accounts: accountsCalls });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    accountsCalls.mockClear();

    await c.refreshAccounts();
    await c.refreshAccounts();
    await c.refreshAccounts();

    expect(accountsCalls).toHaveBeenCalledTimes(1);
  });

  it('refreshAccounts with force: true bypasses throttle', async () => {
    const accountsCalls = vi.fn(async () => accountsResult([acc('u1', 'admin')]));
    const api = fakeApi({ accounts: accountsCalls });
    const { makeWs } = fakeWsFactory();
    const c = new Controller(api, makeWs);
    await c.start();
    accountsCalls.mockClear();

    await c.refreshAccounts();
    await c.refreshAccounts({ force: true });

    expect(accountsCalls).toHaveBeenCalledTimes(2);
  });
  /**
   * #267: 투영 상태는 앱 기동 시 한 번 + **60초마다** 다시 읽는다. 한 번만 읽으면
   * 그 뒤에 투영이 멈춰도 화면은 마지막 성공 상태를 계속 보여 준다 — 멈춘 것을
   * 말하려고 만든 표시가 멈춘 것을 못 말하게 된다.
   */
  it('#267 투영 상태를 기동 시 한 번, 이후 60초마다 다시 읽는다', async () => {
    vi.useFakeTimers();
    try {
      const status = vi.fn(async () => ({
        state: 'ok' as const, configured: true, repo: null, lastLogIndex: 0,
        lastPolledAt: Date.now(), lastAdvancedAt: null, lastError: null,
      }));
      const { makeWs } = fakeWsFactory();
      const c = new Controller(fakeApi({ projectionStatus: status }), makeWs);
      await c.start();
      expect(status).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(status).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(status).toHaveBeenCalledTimes(3);

      // stop() 이 타이머를 걷어야 한다 — 안 그러면 로그아웃 뒤에도 계속 요청한다.
      c.stop();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(status).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * #267 의 핵심 기준: 조회 **실패를 삼키지 않는다**. 삼키면 마지막 성공 상태(또는
   * null)가 그대로 남아 못 읽고 있는 화면이 정상으로 보인다 — "못 읽었다"가 "없다"로
   * 그려지는 그 결함이다(docs/design.md §4).
   */
  it('#267 투영 상태 조회가 실패하면 그 사실이 스토어에 남는다', async () => {
    const { makeWs } = fakeWsFactory();
    const c = new Controller(
      fakeApi({ projectionStatus: vi.fn(async () => { throw new Error('Failed to fetch'); }) }),
      makeWs,
    );
    await c.start();
    expect(useAppStore.getState().projectionStatusError).toBe('Failed to fetch');
    expect(useAppStore.getState().projectionStatus).toBeNull();
  });

  it('#267 다음 성공 조회가 실패 표시를 지운다', async () => {
    let fail = true;
    const status = vi.fn(async () => {
      if (fail) throw new Error('Failed to fetch');
      return {
        state: 'ok' as const, configured: true, repo: null, lastLogIndex: 0,
        lastPolledAt: Date.now(), lastAdvancedAt: null, lastError: null,
      };
    });
    const { makeWs } = fakeWsFactory();
    // 주기 타이머를 세기 전부터 가짜 시계여야 한다 — start() 뒤에 켜면 이미 만들어진
    // 진짜 타이머는 advanceTimersByTime 으로 움직이지 않는다.
    vi.useFakeTimers();
    try {
      const c = new Controller(fakeApi({ projectionStatus: status }), makeWs);
      await c.start();
      expect(useAppStore.getState().projectionStatusError).toBe('Failed to fetch');

      fail = false;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(useAppStore.getState().projectionStatusError).toBeNull();
      expect(useAppStore.getState().projectionStatus?.state).toBe('ok');
      c.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
