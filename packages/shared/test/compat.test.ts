// **앱과 서버가 서로 맞는가** — 호환 하한(`MIN_SERVER_VERSION`)과 그것을 재는 자(#693 후속).
//
// 이 파일이 지키는 것은 값 하나가 아니라 **그 값이 뜻을 갖는 조건**이다. 하한이 잘못
// 잡히면 두 방향으로 망가지는데, 둘 다 조용하다:
//   너무 높으면 — 멀쩡한 서버가 '고장'으로 그려진다. 그러면 그 색이 소음이 되고, 정작
//                진짜 고장이 났을 때 사람이 안 본다.
//   너무 낮으면 — 안 도는 서버가 '정상'으로 그려진다. 화면이 거짓말을 한다.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MIN_SERVER_VERSION, compareRelease, serverCompat } from '../src/compat.js';

/** 릴리스 버전의 **정본**(`desktop/scripts/sync-version.mjs` 상단에 그 근거가 있다). */
const releaseVersion = (JSON.parse(readFileSync(
  new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8',
)) as { version: string }).version;

describe('compareRelease', () => {
  // **문자열 비교로 때우면 여기서 죽는다**: `'0.1.9' > '0.1.100'` 이 참이다. murmur 는
  // 이미 세 자리 patch 를 쓰므로(v0.1.174) 이것은 이론이 아니라 지금 일이다.
  it('세 자리 patch 를 숫자로 견준다', () => {
    expect(compareRelease('0.1.9', '0.1.100')).toBe(-1);
    expect(compareRelease('0.1.100', '0.1.9')).toBe(1);
    expect(compareRelease('0.1.174', '0.1.174')).toBe(0);
    expect(compareRelease('0.2.0', '0.1.999')).toBe(1);
    expect(compareRelease('1.0.0', '0.9.9')).toBe(1);
  });
  // 견줄 수 없는 것을 `0`(같다)으로 눕히지 않는다 — 그러면 포크·자체 빌드가 전부
  // '최신'으로 보인다.
  it('X.Y.Z 가 아니면 null 이다', () => {
    expect(compareRelease('dev', '0.1.174')).toBeNull();
    expect(compareRelease('0.1.174', 'v0.1.174')).toBeNull();
    expect(compareRelease('0.1', '0.1.0')).toBeNull();
  });
});

describe('MIN_SERVER_VERSION', () => {
  it('X.Y.Z 다', () => {
    expect(MIN_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  /**
   * **존재한 적 없는 서버를 요구할 수 없다.** 하한을 지금 릴리스보다 높게 적으면 세상의
   * 모든 서버가 '너무 낡음'이 되고, 최신으로 재배포해도 띠가 안 사라진다 — 사람이 고칠
   * 수 없는 경고가 화면에 붙박이는 것이 가장 나쁜 결말이다.
   *
   * 이 실수는 **숫자를 손으로 올리는 값이라 실제로 일어난다**: 새 기능을 넣으며 "다음
   * 릴리스면 되겠지" 하고 아직 나오지 않은 번호를 적는 것이 자연스러운 손놀림이다.
   */
  it('지금 릴리스보다 높지 않다', () => {
    expect(compareRelease(MIN_SERVER_VERSION, releaseVersion)).not.toBeNull();
    expect(compareRelease(MIN_SERVER_VERSION, releaseVersion)! <= 0).toBe(true);
  });
});

describe('serverCompat', () => {
  it('하한보다 낮으면 too-old, 같거나 높으면 ok', () => {
    expect(serverCompat('0.1.166', '0.1.167')).toBe('too-old');
    expect(serverCompat('0.1.167', '0.1.167')).toBe('ok');
    expect(serverCompat('0.1.174', '0.1.167')).toBe('ok');
    // 세 자리 patch 를 문자열로 견주면 `0.1.99 < 0.1.167` 을 놓친다.
    expect(serverCompat('0.1.99', '0.1.167')).toBe('too-old');
  });

  /**
   * **모르는 것을 `ok` 로 눕히지 않는다.** 그렇게 하면 화면이 확인하지 않은 것을 확인한
   * 것처럼 주장한다(`docs/design.md` §4). 버전을 안 싣는 옛 서버와 자체 빌드가 여기 온다.
   */
  it('버전을 모르거나 견줄 수 없으면 unknown 이다', () => {
    expect(serverCompat(null, '0.1.167')).toBe('unknown');
    expect(serverCompat('dev', '0.1.167')).toBe('unknown');
  });

  it('기본 하한은 MIN_SERVER_VERSION 이다', () => {
    expect(serverCompat(MIN_SERVER_VERSION)).toBe('ok');
  });
});
