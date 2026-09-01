import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_PREFS, prefsStorage } from '../src/lib/prefs';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('prefsStorage', () => {
  it('returns defaults when nothing is stored', () => {
    expect(prefsStorage.load()).toEqual(DEFAULT_PREFS);
  });

  it('round-trips what was saved', () => {
    prefsStorage.save({ notifications: { ...DEFAULT_PREFS.notifications, dm: false } });
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
