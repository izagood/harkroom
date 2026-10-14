/**
 * Claude in Chrome 을 이 머신에서 열 수 있는가(스레드 e8c8365d). 판정 재료는 `harnesses.ts` 처럼 **파일 존재**뿐이다 —
 * 확장이 실제로 브라우저에 켜져 있는지는 턴을 돌려 봐야 안다. 여기서는 없는 것을 있다고 하지 않는 쪽으로만 잰다.
 *
 * 열 수 있으려면 둘 다 참이어야 한다:
 * 1. **앱이 띄운 로컬 오퍼레이터다**(`--launch-nonce` 를 받았다). `run` 으로 뜬 오퍼레이터(원격 VM·launchd)는 사람이
 *    앞에 없는 기계일 수 있다 — 거기서 브라우저를 여는 것은 설계 밖이라 native host 가 있어도 닫는다.
 * 2. 확장의 **native messaging host 매니페스트**가 브라우저 자리 중 하나에 있다. claude 의 `--chrome` 은 이 host 로
 *    확장과 이야기한다(claude 2.1.299 바이너리: 같은 이름을 Chrome·Brave·Arc·Chromium·Edge 자리에 쓴다).
 */
import { join } from 'node:path';
import type { ChromeHostState } from '@harkroom/shared';

export const CHROME_NATIVE_HOST = 'com.anthropic.claude_browser_extension';

/** 매니페스트가 놓이는 사용자 단위 디렉터리(Chromium 계열 공식 자리). 시스템 단위 자리는 claude 가 쓰지 않는다. */
export function chromeNativeHostDirs(platform: NodeJS.Platform, home: string): string[] {
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support');
    return [
      'Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium',
      'BraveSoftware/Brave-Browser', 'Arc/User Data', 'Microsoft Edge',
    ].map((b) => join(support, ...b.split('/'), 'NativeMessagingHosts'));
  }
  if (platform === 'linux') {
    const config = join(home, '.config');
    return ['google-chrome', 'google-chrome-beta', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge']
      .map((b) => join(config, ...b.split('/'), 'NativeMessagingHosts'));
  }
  return [];
}

export interface ChromeHostDeps {
  /** 앱이 띄운 오퍼레이터인가 — `DaemonArgs.launchNonce` 가 있는가. */
  appLaunched: boolean;
  platform: NodeJS.Platform;
  home: string;
  exists(path: string): Promise<boolean>;
}

export async function chromeHostAvailable(deps: ChromeHostDeps): Promise<boolean> {
  return (await chromeHostState(deps)) === 'available';
}

/**
 * 화면에 보일 까닭까지 담은 판정(`OperatorCapabilities.chrome`). 닫힌 까닭이 둘이라 사람이 할 일이 다르다 —
 * `remote` 는 이 기계에서 고칠 길이 없고, `no_extension` 은 확장을 깔면 열린다. 판정 순서는 `chromeHostAvailable` 과 같다.
 */
export async function chromeHostState(deps: ChromeHostDeps): Promise<ChromeHostState> {
  if (!deps.appLaunched) return 'remote';
  for (const dir of chromeNativeHostDirs(deps.platform, deps.home)) {
    if (await deps.exists(join(dir, `${CHROME_NATIVE_HOST}.json`)).catch(() => false)) return 'available';
  }
  return 'no_extension';
}
