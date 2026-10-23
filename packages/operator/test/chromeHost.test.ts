// Claude in Chrome 을 이 머신에서 열 수 있는가(스레드 e8c8365d) — 앱이 띄운 오퍼레이터 + native host 매니페스트.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { CHROME_NATIVE_HOST, chromeHostAvailable, chromeHostState, chromeNativeHostDirs } from '../src/chromeHost.js';

const HOME = '/Users/me';
const chromeManifest = join(HOME, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${CHROME_NATIVE_HOST}.json`);
const braveManifest = join(HOME, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts', `${CHROME_NATIVE_HOST}.json`);
const has = (...paths: string[]) => async (p: string) => paths.includes(p);

describe('chromeHostAvailable', () => {
  it('앱이 띄웠고 Chrome 자리에 매니페스트가 있으면 참', async () => {
    expect(await chromeHostAvailable({ appLaunched: true, platform: 'darwin', home: HOME, exists: has(chromeManifest) })).toBe(true);
  });
  it('Chrome 이 아니라 Brave 에만 있어도 참', async () => {
    expect(await chromeHostAvailable({ appLaunched: true, platform: 'darwin', home: HOME, exists: has(braveManifest) })).toBe(true);
  });
  it('매니페스트가 없으면 거짓', async () => {
    expect(await chromeHostAvailable({ appLaunched: true, platform: 'darwin', home: HOME, exists: has() })).toBe(false);
  });
  it('`run` 으로 뜬 오퍼레이터(원격·launchd)는 매니페스트가 있어도 거짓 — 파일을 보지도 않는다', async () => {
    const seen: string[] = [];
    const exists = async (p: string) => { seen.push(p); return true; };
    expect(await chromeHostAvailable({ appLaunched: false, platform: 'darwin', home: HOME, exists })).toBe(false);
    expect(seen).toEqual([]);
  });
  it('존재 확인이 던지면 그 자리는 없는 것으로 본다', async () => {
    const exists = async () => { throw new Error('EACCES'); };
    expect(await chromeHostAvailable({ appLaunched: true, platform: 'darwin', home: HOME, exists })).toBe(false);
  });
  it('linux 는 ~/.config 아래, 모르는 플랫폼은 자리가 없다', () => {
    expect(chromeNativeHostDirs('linux', '/home/me')).toContain(join('/home/me', '.config', 'google-chrome', 'NativeMessagingHosts'));
    expect(chromeNativeHostDirs('win32', 'C:\\Users\\me')).toEqual([]);
  });
});

describe('chromeHostState — 화면에 보일 까닭', () => {
  it('있음·확장 없음·원격을 가른다', async () => {
    expect(await chromeHostState({ appLaunched: true, platform: 'darwin', home: HOME, exists: has(chromeManifest) })).toBe('available');
    expect(await chromeHostState({ appLaunched: true, platform: 'darwin', home: HOME, exists: has() })).toBe('no_extension');
    expect(await chromeHostState({ appLaunched: false, platform: 'darwin', home: HOME, exists: has(chromeManifest) })).toBe('remote');
  });
});
