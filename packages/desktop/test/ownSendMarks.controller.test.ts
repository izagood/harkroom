/**
 * 컨트롤러 `send`·`reply` 가 「이 기기에서 보낸 글」 표식을 적는 순서(`lib/ownSends.ts`, #1191 후속 d3).
 *
 * 패널은 스토어 커밋마다 표식을 읽으므로 **순서**가 전부다: 보내기 전에 자리의 보내는 중 수를 올리고,
 * 응답의 id 는 그 줄을 스토어에 넣기 **전에** 적고, 끝나면(실패해도) 수를 내린다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller } from '../src/state/controller';
import { chan, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

beforeEach(() => useAppStore.getState().reset());

async function 앱(post: ReturnType<typeof vi.fn>) {
  const api = fakeApi({ channels: vi.fn(async () => [chan('c1', 'general')]), postMessage: post });
  const c = new Controller(api, fakeWsFactory().makeWs);
  await c.start();
  useAppStore.getState().set({ activeChannelId: 'c1', threadRootId: 'root1' });
  return c;
}

describe('ownSend 표식', () => {
  it('send: 보내는 중엔 채널 열쇠가 서고, 응답 id 는 줄이 스토어에 들어가기 전에 적히며, 끝나면 열쇠가 사라진다', async () => {
    let inFlightDuringPost: number | undefined;
    const seen: Array<{ idMarked: boolean }> = [];
    const unsub = useAppStore.subscribe((s) => {
      if (s.messages.c1?.some((m) => m.id === 'm-post') && seen.length === 0) seen.push({ idMarked: s.ownSendIds['m-post'] === true });
    });
    const post = vi.fn(async () => {
      inFlightDuringPost = useAppStore.getState().sendsInFlight.c1;
      return { message: msg('m-post', 'c1', 99, 'sent'), notified: null };
    });
    const c = await 앱(post);
    await c.send('안녕');
    unsub();
    expect(inFlightDuringPost).toBe(1);
    expect(seen).toEqual([{ idMarked: true }]);
    expect(useAppStore.getState().sendsInFlight).toEqual({});
    expect(useAppStore.getState().ownSendIds['m-post']).toBe(true);
  });

  it('reply: 열쇠는 스레드 뿌리다 — 채널 패널이 답글을 자기 보냄으로 읽지 않는다', async () => {
    let keys: string[] = [];
    const post = vi.fn(async () => {
      keys = Object.keys(useAppStore.getState().sendsInFlight);
      return { message: msg('r-post', 'c1', 100, 'reply', 'u1', { threadRootId: 'root1' }), notified: null };
    });
    const c = await 앱(post);
    await c.reply('답', [], 'c1', 'root1', true);
    expect(keys).toEqual(['root1']);
    expect(useAppStore.getState().sendsInFlight).toEqual({});
    expect(useAppStore.getState().ownSendIds['r-post']).toBe(true);
  });

  it('보내기가 실패해도 보내는 중 수는 내려간다 — 남으면 그 뒤 소켓으로 온 내 이름 글이 전부 따라간다', async () => {
    const post = vi.fn(async () => { throw new Error('boom'); });
    const c = await 앱(post);
    await expect(c.send('안녕')).rejects.toThrow('boom');
    expect(useAppStore.getState().sendsInFlight).toEqual({});
  });
});
