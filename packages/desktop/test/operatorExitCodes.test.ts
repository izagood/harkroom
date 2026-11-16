/**
 * 오퍼레이터(Rust `harkroom-operator-rs serve`)가 **점유로 물러날 때 내는 종료 코드**와
 * 앱(`src-tauri/src/daemon_client.rs`)이 점유로 읽는 코드가 같은지 재는 회귀선.
 *
 * ## 왜 필요한가
 *
 * 값이 두 crate 에 따로 적혀 있다(앱은 오퍼레이터 crate 를 의존하지 않는다). Node 오퍼레이터를 걷은 뒤
 * Rust `serve` 는 점유를 보고도 1 로 끝났고, 앱은 10 일 때만 「다른 harkroom 이 쥐고 있다」를 붙이므로
 * 그 안내가 소리 없이 죽어 있었다. 옛 대조(`daemonExitCodes.test.ts`)는 Node 쪽 값만 보고 있어 드러나지 않았다.
 *
 * 소스를 읽어 대조하는 규율은 `daemonExitCodes.test.ts`·`runnerShellScope.test.ts` 와 같다.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string): string =>
  readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');

/** 값의 **출처** — 오퍼레이터가 점유로 물러나는 자리. */
const SERVE_RS = read('../../../crates/harkroom-operator/src/serve.rs');
/** 그 값을 읽는 쪽. */
const DAEMON_RS = read('../src-tauri/src/daemon_client.rs');

const only = (source: string, re: RegExp, what: string): string => {
  const hits = [...source.matchAll(re)];
  // 여러 번 적혀 있으면 그것 자체가 이 회귀선이 막으려는 상태다.
  expect(hits, `${what} 를 정확히 한 자리에서 찾지 못했다`).toHaveLength(1);
  const captured = hits[0]?.[1];
  if (captured === undefined) {
    throw new Error(`${what} 의 숫자를 못 읽었다 — 상수 선언 모양이 바뀌었나`);
  }
  return captured;
};

describe('오퍼레이터 점유 종료 코드 계약', () => {
  it('`EXIT_OCCUPIED` 가 Rust 오퍼레이터와 앱에서 같은 값이다', () => {
    const op = only(SERVE_RS, /pub const EXIT_OCCUPIED: i32 = (\d+);/g, 'serve.rs 의 EXIT_OCCUPIED');
    const app = only(DAEMON_RS, /const EXIT_OCCUPIED: i32 = (\d+);/g, 'daemon_client.rs 의 EXIT_OCCUPIED');
    expect(app, '오퍼레이터가 물러나는 코드와 앱이 점유로 읽는 코드가 갈렸다').toBe(op);
  });

  it('`serve` 가 점유 갈래에서 그 상수로 끝난다 — 숫자를 따로 적지 않는다', () => {
    // `ClaimOutcome::Occupied` 갈래의 (줄, 종료 코드) 튜플이 상수를 쓰는지 본다.
    // 갈래는 `Ok(ClaimOutcome::Occupied …) => (` 부터 다음 `Err(` 갈래 앞까지다.
    const arm = /Ok\(ClaimOutcome::Occupied \{[^}]*\}\) => \(([\s\S]*?)\n\s*Err\(/.exec(SERVE_RS)?.[1];
    expect(arm, 'serve.rs 에서 점유 갈래를 못 찾았다').toBeDefined();
    expect(arm).toMatch(/,\s*EXIT_OCCUPIED,?\s*\),?\s*$/);
  });

  it('`serve` 의 다른 실패 코드가 점유 코드와 겹치지 않는다', () => {
    const op = only(SERVE_RS, /pub const EXIT_OCCUPIED: i32 = (\d+);/g, 'serve.rs 의 EXIT_OCCUPIED');
    // `(json!(…).to_string(), N)` 꼴로 적힌 숫자 코드들. 점유 코드를 숫자로 다시 적으면 오진의 씨앗이다.
    const literals = [...SERVE_RS.matchAll(/\.to_string\(\),\s*(\d+),?\s*\)/g)].map((m) => m[1]);
    expect(literals.length).toBeGreaterThan(0);
    expect(literals).not.toContain(op);
  });
});
