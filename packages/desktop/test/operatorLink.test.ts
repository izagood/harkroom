import { describe, expect, it } from 'vitest';
import { SERVER_LINK_REASONS } from '@harkroom/shared/daemonProtocol';
import { LINK_REASONS, hostOfBaseUrl, LINK_GRACE_MS, LINK_LONG_MS, linkActionKey, linkDismissKey, linkPhase, parseServerLinkState } from '../src/lib/operatorLink';

const down = (since: number, reason = 'dns') => parseServerLinkState({
  state: 'down', reason, closeCode: null, host: 'one.example.com', downSinceMs: since, lastUpMs: null, attempts: 3, nextRetryAtMs: null,
})!;

describe('operatorLink 판정', () => {
  it('60초 안의 끊김은 정상, 60초~5분은 재시도 중, 5분부터 빨강', () => {
    expect(linkPhase(null, 0)).toBe('ok');
    expect(linkPhase(down(0), LINK_GRACE_MS - 1)).toBe('ok');
    expect(linkPhase(down(0), LINK_GRACE_MS)).toBe('retry');
    expect(linkPhase(down(0), LINK_LONG_MS - 1)).toBe('retry');
    expect(linkPhase(down(0), LINK_LONG_MS)).toBe('long');
    expect(linkPhase({ ...down(0), state: 'up', downSinceMs: null }, LINK_LONG_MS * 9)).toBe('ok');
  });
  it('모양이 틀리면 버리고, 모르는 까닭은 other', () => {
    expect(parseServerLinkState({ state: 'weird', host: 'h' })).toBeNull();
    expect(parseServerLinkState({ state: 'down' })).toBeNull();
    expect(parseServerLinkState({ state: 'down', host: 'h', reason: 'boom', downSinceMs: 1 })?.reason).toBe('other');
  });
  it('[나중에] 열쇠는 까닭이 바뀌면 달라진다', () => {
    expect(linkDismissKey(down(5, 'offline'))).not.toBe(linkDismissKey(down(5, 'dns')));
  });
  it('까닭마다 할 일 한 줄', () => {
    expect(linkActionKey('dns')).toBe('opLink.do.network');
    expect(linkActionKey('offline')).toBe('opLink.do.network');
    expect(linkActionKey('refused')).toBe('opLink.do.wait');
    expect(linkActionKey('auth')).toBe('opLink.do.auth');
    expect(linkActionKey('other')).toBe('opLink.do.other');
  });
  it('까닭 목록이 shared 와 같다', () => { expect([...LINK_REASONS]).toEqual([...SERVER_LINK_REASONS]); });
  it('커뮤니티 주소의 호스트', () => {
    expect(hostOfBaseUrl('https://One.example.com:8443/x')).toBe('one.example.com');
    expect(hostOfBaseUrl('nope')).toBeNull();
  });
});
