/**
 * daemon 종료 코드가 **두 언어에서 같은 값인지** 재는 회귀선.
 *
 * ## 왜 이 파일이 필요한가 — 값이 두 곳에 적혀 있다
 *
 * `EXIT_OCCUPIED` 는 daemon 이 정하고(`packages/daemon/src/run.ts`) 앱이 읽는다
 * (`src-tauri/src/daemon_client.rs`). Rust 가 TS 상수를 import 할 방법이 없어 숫자가
 * **두 벌 존재한다.**
 *
 * 갈리면 조용히 틀린다: daemon 이 점유로 물러났는데 앱은 그것을 다른 사유로 읽고,
 * *"이미 다른 murmur 가 daemon 을 쥐고 있다 — 그 앱을 종료하라"* 대신 종료 코드만
 * 올린다. 그것이 정확히 이 후속 작업이 없앤 상태다(실측 2026-09-07). 반대 방향도 같다 —
 * 점유가 아닌 사유에 그 문구를 붙이면 `#473` 류의 오진이 된다.
 *
 * **소스를 읽어 대조하는 규율**은 `missingToolchainNotice.test.tsx`(설치 안내 문장)와
 * `runnerShellScope.test.ts`(Rust 쪽 경계)와 같다. 문자열을 손으로 옮겨 적지 않는다.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string): string =>
  readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');

/** `packages/daemon/src/run.ts` — 값의 **출처**다. */
const RUN_TS = read('../../daemon/src/run.ts');
/** `src-tauri/src/daemon_client.rs` — 그 값을 읽는 쪽. */
const DAEMON_RS = read('../src-tauri/src/daemon_client.rs');

/** 한 자리에서만 찾는다 — 여러 번 적혀 있으면 그것 자체가 결함이다. */
const only = (source: string, re: RegExp, what: string): string => {
  const hits = [...source.matchAll(re)];
  // 한 자리여야 한다 — 여러 번 적혀 있으면 그것 자체가 이 회귀선이 막으려는 상태다.
  expect(hits, `${what} 를 정확히 한 자리에서 찾지 못했다`).toHaveLength(1);
  const captured = hits[0]?.[1];
  if (captured === undefined) {
    throw new Error(`${what} 의 숫자를 못 읽었다 — 상수 선언 모양이 바뀌었나`);
  }
  return captured;
};

describe('daemon 종료 코드 계약', () => {
  it('`EXIT_OCCUPIED` 가 daemon 과 앱에서 같은 값이다', () => {
    const ts = only(RUN_TS, /export const EXIT_OCCUPIED = (\d+);/g, 'run.ts 의 EXIT_OCCUPIED');
    const rs = only(DAEMON_RS, /const EXIT_OCCUPIED: i32 = (\d+);/g, 'Rust 의 EXIT_OCCUPIED');

    expect(rs, 'daemon 이 물러나는 코드와 앱이 점유로 읽는 코드가 갈렸다').toBe(ts);
  });

  it('앱이 그 상수로 판정한다 — 숫자를 따로 적어 비교하지 않는다', () => {
    // 상수를 만들어 두고 정작 판정에는 `Some(10)` 을 적으면 이 계약은 다시 두 벌이 된다.
    expect(DAEMON_RS).toContain('if code == Some(EXIT_OCCUPIED)');
  });

  it('daemon 이 그 상수로 물러난다 — `main.ts` 가 숫자를 따로 적지 않는다', () => {
    const mainTs = read('../../daemon/src/main.ts');
    expect(mainTs).toContain('process.exit(EXIT_OCCUPIED)');
  });
});
