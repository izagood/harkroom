import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MessageRow } from '@murmur/shared';
import { useAppStore } from '../src/state/appStore';
import { Controller } from '../src/state/controller';
import { fakeApi, acc, msg } from './helpers/fakeApi';

const seed = (reactions: MessageRow['reactions'] = []) => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
    activeChannelId: 'c1',
  });
  useAppStore.getState().upsertMessages('c1', [{ ...msg('m1', 'c1', 1, '본문', 'u2'), reactions }]);
};

const only = () => useAppStore.getState().messages['c1']![0]!;

/** 이벤트를 직접 먹인다 — 소켓을 세우지 않고 반영 규칙만 본다. */
const feed = (c: Controller, e: unknown) =>
  (c as unknown as { handleEvent: (e: unknown) => void }).handleEvent(e);

beforeEach(() => seed());

describe('reaction events from the socket', () => {
  it('adds the reaction someone else pressed', () => {
    const c = new Controller(fakeApi());

    feed(c, { type: 'reaction.added', channelId: 'c1', messageId: 'm1', emoji: '👀', accountId: 'u2' });

    expect(only().reactions).toEqual([{ emoji: '👀', accountIds: ['u2'] }]);
  });

  // 내 클릭은 로컬 갱신 + 소켓 이벤트로 두 번 도착한다. 두 번 세면 1 이 2 가 된다.
  it('does not count the same person twice', () => {
    seed([{ emoji: '👀', accountIds: ['u2'] }]);
    const c = new Controller(fakeApi());

    feed(c, { type: 'reaction.added', channelId: 'c1', messageId: 'm1', emoji: '👀', accountId: 'u2' });

    expect(only().reactions[0]!.accountIds).toEqual(['u2']);
  });

  it('joins an existing emoji instead of making a second chip', () => {
    seed([{ emoji: '👀', accountIds: ['u2'] }]);
    const c = new Controller(fakeApi());

    feed(c, { type: 'reaction.added', channelId: 'c1', messageId: 'm1', emoji: '👀', accountId: 'u1' });

    expect(only().reactions).toHaveLength(1);
    expect(only().reactions[0]!.accountIds).toEqual(['u2', 'u1']);
  });

  it('removes just that person', () => {
    seed([{ emoji: '👀', accountIds: ['u1', 'u2'] }]);
    const c = new Controller(fakeApi());

    feed(c, { type: 'reaction.removed', channelId: 'c1', messageId: 'm1', emoji: '👀', accountId: 'u1' });

    expect(only().reactions[0]!.accountIds).toEqual(['u2']);
  });

  it('drops the chip when the last person leaves', () => {
    seed([{ emoji: '👀', accountIds: ['u1'] }]);
    const c = new Controller(fakeApi());

    feed(c, { type: 'reaction.removed', channelId: 'c1', messageId: 'm1', emoji: '👀', accountId: 'u1' });

    expect(only().reactions).toEqual([]);
  });

  it('ignores an event for a message it has never seen', () => {
    const c = new Controller(fakeApi());

    feed(c, { type: 'reaction.added', channelId: 'c1', messageId: 'gone', emoji: '👀', accountId: 'u2' });

    expect(only().reactions).toEqual([]);
    expect(useAppStore.getState().messages['c1']).toHaveLength(1);
  });

  // 누른 사람이 처음 보는 계정이면 이름이 '…'로 남는다 — 리액션 툴팁이 빈칸이 된다.
  it('fetches the directory when an unknown account reacts', () => {
    const accounts = vi.fn(async () => ({ accounts: [acc('u1', 'me'), acc('u9', 'newcomer')], groups: [] }));
    const c = new Controller(fakeApi({ accounts }));

    feed(c, { type: 'reaction.added', channelId: 'c1', messageId: 'm1', emoji: '👀', accountId: 'u9' });

    expect(accounts).toHaveBeenCalled();
  });
});

describe('pressing a reaction locally', () => {
  it('shows my reaction as soon as the server accepts it', async () => {
    const addReaction = vi.fn(async () => undefined);
    const c = new Controller(fakeApi({ addReaction }));

    await c.toggleReaction('c1', 'm1', '👀', true);

    expect(addReaction).toHaveBeenCalledWith('c1', 'm1', '👀');
    expect(only().reactions).toEqual([{ emoji: '👀', accountIds: ['u1'] }]);
  });

  it('takes my reaction back off when I remove it', async () => {
    seed([{ emoji: '👀', accountIds: ['u1'] }]);
    const removeReaction = vi.fn(async () => undefined);
    const c = new Controller(fakeApi({ removeReaction }));

    await c.toggleReaction('c1', 'm1', '👀', false);

    expect(removeReaction).toHaveBeenCalledWith('c1', 'm1', '👀');
    expect(only().reactions).toEqual([]);
  });

  // 서버가 거절하면(개수 상한, 권한) 화면에 남아 있으면 안 된다 — 새로고침에 사라진다.
  it('does not show a reaction the server refused', async () => {
    const addReaction = vi.fn(async () => { throw new Error('409'); });
    const c = new Controller(fakeApi({ addReaction }));

    await c.toggleReaction('c1', 'm1', '👀', true).catch(() => {});

    expect(only().reactions).toEqual([]);
  });
});
