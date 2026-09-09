import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_INBOX_FILTER, DEFAULT_PREFS, inboxStorage, prefsStorage } from '../src/lib/prefs';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('prefsStorage', () => {
  it('returns defaults when nothing is stored', () => {
    expect(prefsStorage.load()).toEqual(DEFAULT_PREFS);
  });

  it('round-trips what was saved', () => {
    prefsStorage.save({ ...DEFAULT_PREFS, notifications: { ...DEFAULT_PREFS.notifications, dm: false } });
    expect(prefsStorage.load().notifications.dm).toBe(false);
    expect(prefsStorage.load().notifications.mention).toBe(true);
  });

  // 앱 업데이트로 키가 추가되면 옛 저장본에는 그 키가 없다. 병합하지 않으면 undefined 가
  // falsy 로 읽혀 새 알림 종류가 처음부터 꺼진 채로 시작한다 — 사용자는 끈 적이 없다.
  it('fills in keys missing from an older stored shape', () => {
    localStorage.setItem('murmur.prefs', JSON.stringify({ notifications: { enabled: false } }));
    const p = prefsStorage.load();
    expect(p.notifications.enabled).toBe(false);
    expect(p.notifications.showPreview).toBe(true);
  });

  it('recovers to defaults from corrupt json', () => {
    localStorage.setItem('murmur.prefs', '{not json');
    expect(prefsStorage.load()).toEqual(DEFAULT_PREFS);
  });

  // 사생활 모드처럼 쓰기를 거부하는 저장소에서도 앱이 죽지 않아야 한다.
  it('tolerates a storage that refuses writes', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => prefsStorage.save(DEFAULT_PREFS)).not.toThrow();
  });
});

/**
 * 인박스에서 고른 칩(2026-09-09 보고: *"Unread 로 해놨는데 다시 켜면 돌아간다"*).
 *
 * 저장본을 **검사해서** 읽는 것을 함께 잰다 — 칩을 빼거나 이름을 바꾸는 날 옛 값이 그대로
 * 상태가 되면, 아무 칩도 눌린 것으로 보이지 않아 무엇으로 좁혀져 있는지 화면이 말하지
 * 못한다. 그 자리가 조용히 깨지는 것이라 테스트로 못 박아 둔다.
 */
describe('inboxStorage', () => {
  it('아무것도 저장돼 있지 않으면 기본 칩이다', () => {
    expect(inboxStorage.loadFilter()).toBe(DEFAULT_INBOX_FILTER);
  });

  it('고른 칩을 그대로 돌려준다', () => {
    inboxStorage.saveFilter('unread');
    expect(inboxStorage.loadFilter()).toBe('unread');
  });

  it('모르는 값이 저장돼 있으면 기본 칩으로 떨어진다', () => {
    localStorage.setItem('murmur.inboxFilter', 'mentions-only');
    expect(inboxStorage.loadFilter()).toBe(DEFAULT_INBOX_FILTER);
  });

  it('쓰기를 거부하는 저장소에서도 죽지 않는다', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => inboxStorage.saveFilter('blocking')).not.toThrow();
  });
});
