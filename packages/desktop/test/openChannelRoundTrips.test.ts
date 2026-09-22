/**
 * **채널 열기는 왕복 하나로 끝난다** (jaebin 신고 2026-09-22: "처음 대화 가져오는 데 너무
 * 오래 걸린다").
 *
 * 이 저장소의 서버는 Cloudflare 엣지 뒤에 있고, 실측으로 **왕복 하나가 250ms** 다
 * (`x-envoy-upstream-service-time` 은 1~7ms — 나머지는 전부 엣지까지의 거리다). 그래서
 * 체감 로딩 시간은 서버가 쓰는 ms 가 아니라 **직렬 왕복의 수**로 결정된다.
 *
 * 그런데 `openChannel` 은 메시지를 받아 스토어에 넣은 **뒤에** 읽음 처리 셋을 직렬로
 * 기다리고 있었다 — `markRead` → `inboxUnread` → `markChannelRead`. 그 셋은 화면이 기다릴
 * 이유가 없는데(결과는 사이드바 배지뿐이다), `openThread`·`openMessage` 가 `openChannel`
 * 을 await 하므로 인박스에서 답글 하나를 여는 데 왕복이 예닐곱 번 쌓였다.
 *
 * 이 파일이 붙잡는 규율:
 *  - `openChannel` 이 **끝난 시점에** 읽음 처리 왕복이 아직 안 끝나 있어도 된다.
 *  - 그래도 **구분선은 동기로 정해진다** — 비동기로 미루면 채널이 그려진 뒤에 선이 튀어
 *    들어온다. 그리고 얼리기는 `markChannelRead` 보다 **먼저**여야 한다(그 순서가 깨지면
 *    '여기부터 새 메시지' 선이 사라진다).
 *  - 미룬 왕복은 **빠짐없이 간다** — 안 가면 배지가 영영 안 내려간다.
 */
import { describe, it, expect, vi } from 'vitest';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, Controller } from '../src/state/controller';
import { fakeApi, fakeWsFactory, inboxEntry, msg } from './helpers/fakeApi';

/** 손으로 풀어 주는 promise. "아직 안 끝났다"를 시간이 아니라 상태로 표현한다. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('채널 열기의 왕복 수', () => {
  it('읽음 처리 왕복이 끝나기 전에 openChannel 이 끝난다', async () => {
    useAppStore.getState().reset();
    const { makeWs } = fakeWsFactory();
    const gate = deferred<void>();
    const markChannelRead = vi.fn(async () => { await gate.promise; });
    const messages = vi.fn(async () => ({
      messages: [msg('m1', 'c1', 7, '안녕', 'u2')], hasMore: false,
    }));
    const c = new Controller(fakeApi({ messages, markChannelRead }), makeWs);
    setController(c);
    await c.start();

    // 왕복 하나(messages)만 끝난 상태에서 openChannel 이 반환되어야 한다.
    // `markChannelRead` 는 아직 gate 에 걸려 있다.
    await c.openChannel('c1');

    expect(messages).toHaveBeenCalledTimes(1);
    expect(markChannelRead).toHaveBeenCalledWith('c1', 7);
    // 메시지는 이미 화면에 있다 — 이것이 "기다릴 이유가 없다"의 근거다.
    expect(useAppStore.getState().messages['c1']).toHaveLength(1);
    // 그리고 구분선은 **이미** 정해져 있다(동기).
    expect(useAppStore.getState().dividerSeq['c1']).toBe(0);
    // 읽음 위치는 아직 안 올랐다 — 그 왕복이 안 끝났으니 당연하고, 끝나면 오른다.
    expect(useAppStore.getState().reads['c1']).toBeUndefined();

    gate.resolve();
    await vi.waitFor(() => {
      expect(useAppStore.getState().reads['c1']).toEqual({ lastReadSeq: 7, unread: 0 });
    });
  });

  it('미룬 왕복은 빠짐없이 간다 — inbox 항목도 읽음으로 만든다', async () => {
    useAppStore.getState().reset();
    const { makeWs } = fakeWsFactory();
    const markRead = vi.fn(async () => undefined);
    const inboxUnread = vi.fn(async () => [inboxEntry(11, 'm1', 'mention')]);
    const messages = vi.fn(async () => ({
      messages: [msg('m1', 'c1', 7, '안녕', 'u2')], hasMore: false,
    }));
    const c = new Controller(fakeApi({ messages, markRead, inboxUnread }), makeWs);
    setController(c);
    await c.start();

    await c.openChannel('c1');
    await vi.waitFor(() => { expect(markRead).toHaveBeenCalledWith([11]); });
  });

  it('읽을 것도 올릴 것도 없으면 왕복을 만들지 않는다', async () => {
    useAppStore.getState().reset();
    const { makeWs } = fakeWsFactory();
    const markRead = vi.fn(async () => undefined);
    const markChannelRead = vi.fn(async () => undefined);
    // 빈 채널: 최신 seq 가 0 이라 얼린 값(0)보다 크지 않다.
    const messages = vi.fn(async () => ({ messages: [], hasMore: false }));
    const c = new Controller(fakeApi({ messages, markRead, markChannelRead }), makeWs);
    setController(c);
    await c.start();

    await c.openChannel('c1');
    await Promise.resolve();
    expect(markRead).not.toHaveBeenCalled();
    expect(markChannelRead).not.toHaveBeenCalled();
  });
});
