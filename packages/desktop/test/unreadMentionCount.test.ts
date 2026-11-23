import { describe, it, expect } from 'vitest';
import { isMentionOrDm, unreadMentionCount } from '../src/state/unread';

describe('배지 판정 — 모바일(inboxMentionCount)과 같다', () => {
  it('멘션·DM·팀장으로서 불림을 센다', () => {
    for (const reason of ['mention', 'dm', 'team_mention']) expect(isMentionOrDm({ reason })).toBe(true);
  });
  it('답글·물음 답 같은 다른 사유는 세지 않는다', () => {
    for (const reason of ['reply', 'ask_answered', 'wake', 'delegation_done']) expect(isMentionOrDm({ reason })).toBe(false);
  });
});

describe('unreadMentionCount', () => {
  it('판정에 맞는 줄만 센다', () => {
    expect(unreadMentionCount([{ reason: 'mention' }, { reason: 'team_mention' }, { reason: 'reply' }, { reason: 'dm' }])).toBe(3);
  });
});
