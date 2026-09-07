// **평문 http 서버에 붙을 수 있는 상태**인지를 고정하는 회귀선.
//
// 실측(2026-09-07). 설치본 v0.1.6 으로 사내 VM 의 서버(`http://<사내호스트>:3400`)에
// 붙으려 하니 `ConnectScreen` 이 `Could not reach the server` 를 냈다. 그런데 **서버
// 로그에는 그 시각의 요청이 아예 없었다.** 요청이 나가지 못한 것이다:
//
//   com.apple.WebKit.Networking (CFNetwork)
//   NSURLErrorDomain Code=-1022 "The resource could not be loaded because the
//   App Transport Security policy requires the use of a secure connection."
//
// macOS ATS 는 평문 http 를 기본으로 막고 **localhost 만 예외**다. 그래서 로컬 개발
// (`http://localhost:3400`)은 되고 사내 호스트는 안 됐다 — 같은 앱, 같은 코드로.
//
// 이 앱의 self-host 이야기가 그 예외에 기대고 있었다: `docker compose up -d` 가 띄우는
// 것은 평문 http 3400 이고, 사내에 세우는 서버는 TLS 없이 도는 경우가 흔하다. 즉
// **문서대로 self-host 하면 데스크탑 앱으로는 붙을 수 없었다.**
//
// 그래서 번들 Info.plist 에 ATS 예외를 선언한다. 이 파일은 그 선언이 조용히 사라지지
// 않게 붙잡는다 — 사라지면 증상이 "서버가 안 닿는다"로 나타나고, 원인(OS 가 요청을
// 보내지 않았다)에서 아주 멀어진다. 그 거리를 이미 한 번 걸었다.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const SRC_TAURI_DIR = path.resolve(__dirname, '../src-tauri');
const INFO_PLIST = path.join(SRC_TAURI_DIR, 'Info.plist');

/** `plutil` 은 macOS 고유다. CI 는 리눅스이므로 그 검사만 건너뛴다. */
const macOS = process.platform === 'darwin';

describe('Info.plist — 평문 http 를 막지 않는다 (사내 self-host 가 대개 http 다)', () => {
  /**
   * **파일이 있어야 병합된다.** Tauri 는 `src-tauri/Info.plist` 를 번들 Info.plist 에
   * 얹는다(공식 문서: macOS Application Bundle). 파일 이름과 자리가 곧 계약이다 —
   * 옮기거나 지우면 빌드는 성공하고 앱만 못 붙는다.
   */
  it('src-tauri/Info.plist 가 있다', () => {
    expect(existsSync(INFO_PLIST), `${INFO_PLIST} 가 있어야 번들에 병합된다`).toBe(true);
  });

  /**
   * **`plutil -lint` 가 정본이다.** 깨진 plist 를 Tauri 가 병합하면 번들 Info.plist 가
   * 망가지고, 그때 앱은 아예 뜨지 않는다. 문자열로 XML 을 흉내내 재면 그것을 못 잡는다.
   * `entitlements.plist` 를 재는 방식과 같다(`bundleSignable.test.ts`).
   */
  it.skipIf(!macOS)('유효한 plist 다', () => {
    execFileSync('plutil', ['-lint', INFO_PLIST]);
  });

  /** BOM 이 붙으면 도구들이 싫어한다 — 첫 바이트를 직접 본다. */
  it('BOM 이 없는 XML 이다', () => {
    const raw = readFileSync(INFO_PLIST);
    expect(raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'BOM 이 있으면 안 된다')
      .toBe(false);
    expect(raw.subarray(0, 5).toString('utf8')).toBe('<?xml');
  });

  /**
   * **이것이 이 파일의 핵심이다.** `NSAllowsArbitraryLoadsInWebContent` 가
   * `NSAppTransportSecurity` 안에 `<true/>` 로 선언돼 있어야 한다.
   *
   * 키가 파일 어딘가에 있는 것으로는 부족하다 — `NSAppTransportSecurity` **딕셔너리
   * 안**에 있어야 OS 가 읽는다. 그래서 그 딕셔너리 범위를 잘라내 그 안에서 잰다.
   */
  it('NSAppTransportSecurity 안에 NSAllowsArbitraryLoadsInWebContent 가 true 다', () => {
    const source = readFileSync(INFO_PLIST, 'utf8');
    const ats = source.match(
      /<key>\s*NSAppTransportSecurity\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/,
    );
    expect(ats, 'NSAppTransportSecurity 딕셔너리가 없다').not.toBeNull();
    expect(ats![1], '웹뷰의 평문 http 가 다시 막힌다(-1022)')
      .toMatch(/<key>\s*NSAllowsArbitraryLoadsInWebContent\s*<\/key>\s*<true\s*\/>/);
  });

  /**
   * 대조군 — **웹뷰 밖의 ATS 는 그대로 둔다.** 위 검사만 있으면 `NSAllowsArbitraryLoads`
   * 로 앱 전체의 ATS 를 끄는 변경도 통과한다.
   *
   * 앱이 평문으로 말해야 하는 상대는 사용자가 세운 murmur 서버 하나이고, 그 통신은 전부
   * 웹뷰의 `fetch`/WebSocket 이다(`src/lib/api.ts`, `src/state/controller.ts`). 반면
   * 네이티브 쪽(업데이터 → GitHub)은 https 로만 말한다. 그쪽 보호까지 걷어낼 이유가 없다.
   */
  it('NSAllowsArbitraryLoads 로 앱 전체를 열지는 않는다', () => {
    const source = readFileSync(INFO_PLIST, 'utf8');
    // 주석에서 이 키를 언급하므로(왜 안 쓰는지) **선언 형태**를 잰다.
    expect(source, '웹뷰 밖의 ATS 까지 끌 이유가 없다')
      .not.toMatch(/<key>\s*NSAllowsArbitraryLoads\s*<\/key>/);
  });
});
