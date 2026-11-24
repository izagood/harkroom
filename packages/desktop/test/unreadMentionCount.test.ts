import { describe, it, expect } from 'vitest';
import { isMentionOrDm, unreadMentionCount } from '../src/state/unread';

describe('배지 판정', () => {
  it('멘션·DM·팀장으로서 불림을 센다', () => {
    for (const reason of ['mention', 'dm', 'team_mention']) expect(isMentionOrDm({ reason })).toBe(true);
  });
  it('답글·물음 답 같은 다른 사유는 세지 않는다', () => {
    for (const reason of ['reply', 'ask_answered', 'wake', 'delegation_done']) expect(isMentionOrDm({ reason })).toBe(false);
  });
});

describe('unreadMentionCount', () => {
  const at = (reason: string, channelId = 'c1') => ({ reason, channelId });

  it('판정에 맞는 줄만 센다', () => {
    const unread = [at('mention'), at('team_mention'), at('reply'), at('dm')];
    expect(unreadMentionCount({ unread, channelPrefs: {} })).toBe(3);
  });

  it('음소거 채널의 것은 빼고 센다 — 다른 알림 수준은 센다', () => {
    const unread = [at('mention', 'muted'), at('dm', 'muted'), at('mention', 'all'), at('mention', 'mentions'), at('mention', 'none-set')];
    const channelPrefs = { muted: { notifyLevel: 'none' }, all: { notifyLevel: 'all' }, mentions: { notifyLevel: 'mentions' } } as const;
    expect(unreadMentionCount({ unread, channelPrefs })).toBe(3);
  });
});
