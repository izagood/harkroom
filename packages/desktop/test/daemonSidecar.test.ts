// daemon 사이드카 빌드 경로의 회귀선(#431 2단계-a).
//
// 여기서 재는 것은 **배포 형태**뿐이다. P2 이후 앱과 함께 나가는 오퍼레이터는 Rust(`harkroom-operator-rs`)
// 하나이고, 옛 Node 오퍼레이터(P3 에서 지움)는 번들에 없다.
//
// 2단계-b 에서 **daemon 이 상주 프로세스가 됐다.** 그래서 실행 회귀선이 종료를 기다리던
// 방식(`execFileSync`)에서 첫 줄만 읽고 거두는 방식으로 바뀌었다 — 재는 대상은 그대로다
// (아래 그 자리의 주석 참조).
//
// 무거운 빌드(esbuild + rustc)는 매 테스트 실행에서 돌리지 않는다. 그래서 이 파일은
// **산출물이 이미 있으면** 그 실물을 재고, 없으면 사람이 알아볼 이유로 건너뛴다
// (`src-tauri/src/main.rs` 의 사이드카 통합 테스트가 쓰는 것과 같은 방식이다).
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const SRC_TAURI_DIR = path.resolve(__dirname, '../src-tauri');
const BINARIES_DIR = path.join(SRC_TAURI_DIR, 'binaries');
const TAURI_CONF_PATH = path.join(SRC_TAURI_DIR, 'tauri.conf.json');

function readTauriConf(): { bundle?: { externalBin?: string[]; resources?: Record<string, string> } } {
  return JSON.parse(readFileSync(TAURI_CONF_PATH, 'utf-8'));
}

/** `binaries/` 에서 `<name>-<triple>` 산출물을 찾는다. 없으면 `null`(빌드 전). */
function findSidecar(name: string): string | null {
  if (!existsSync(BINARIES_DIR)) return null;
  const hit = readdirSync(BINARIES_DIR).find((f) => f.startsWith(`${name}-`));
  return hit ? path.join(BINARIES_DIR, hit) : null;
}

const SKIP_HINT = '먼저 `pnpm --filter @harkroom/desktop build:sidecar` 를 돌려라';

describe('tauri.conf.json — daemon 이 externalBin 에 있다 (#431 2단계-a)', () => {
  /**
   * 이것이 "daemon 이 앱과 함께 배포된다"를 성립시키는 유일한 선언이다. 빠지면
   * `tauri build` 가 daemon 을 번들에 넣지 않고, 그 사실은 배포된 앱이 daemon 을
   * 못 찾을 때 처음 드러난다.
   */
  it('externalBin 이 Rust 오퍼레이터·Rust 러너만 싣는다 — Node 오퍼레이터·Node 러너는 싣지 않는다', () => {
    const externalBin = readTauriConf().bundle?.externalBin;
    expect(externalBin).not.toContain('binaries/harkroom-runner');
    // P2: 오퍼레이터는 Rust 하나다. 옛 Node 오퍼레이터(`binaries/harkroom-operator`)는 싣지 않는다 — 되돌리는 스위치도 없다.
    expect(externalBin).toContain('binaries/harkroom-operator-rs');
    expect(externalBin).not.toContain('binaries/harkroom-operator');
    // Rust 러너가 실린다 — 띄우는 것은 앱이 아니라 오퍼레이터다(자기 옆에서 찾는다).
    expect(externalBin).toContain('binaries/harkroom-runner-rs');
  });

  /**
   * `resources` 는 비어 있다 — `node-pty` 는 Node 러너의 것이었고 그 러너는 번들에서 빠졌다. 다시 생기면 서명·공증이
   * 그 안의 Mach-O 를 따로 챙겨야 한다(`sign-app.mjs`).
   */
  it('resources 가 없다 — node-pty 를 싣지 않는다', () => {
    expect(readTauriConf().bundle?.resources).toBeUndefined();
  });
});

describe('오퍼레이터 사이드카 산출물', () => {
  /**
   * P2 — `build:sidecar` 는 옛 Node 오퍼레이터를 더 내지 않는다. 산출물 디렉터리는 빌드마다 통째로 비워지므로
   * (`build-sidecars.mjs`) 여기 `harkroom-operator-<triple>` 이 있으면 누군가 그 빌드를 되살린 것이다.
   */
  it('Node 오퍼레이터·Node 러너 산출물이 없다', () => {
    const operator = findSidecar('harkroom-operator-rs');
    if (!operator) {
      console.warn(`건너뜀: 사이드카가 ${BINARIES_DIR} 에 없다 — ${SKIP_HINT}`);
      return;
    }
    const node = readdirSync(BINARIES_DIR).filter(
      (f) => /^harkroom-operator-(?!rs-)/.test(f) || /^harkroom-runner-(?!rs-)/.test(f) || f === 'node_modules',
    );
    expect(node).toEqual([]);
  });

  /**
   * Rust 러너와 Rust 오퍼레이터가 **함께** 같은 triple 로 나온다. 갈리면 `tauri build --target` 이 다른 아키텍처를 싣는다.
   */
  it('Rust 러너와 Rust 오퍼레이터가 같은 triple 로 함께 나온다', () => {
    const runner = findSidecar('harkroom-runner-rs');
    const operator = findSidecar('harkroom-operator-rs');
    if (!runner || !operator) {
      console.warn(`건너뜀: 사이드카가 ${BINARIES_DIR} 에 없다 — ${SKIP_HINT}`);
      return;
    }
    const triple = (p: string) => path.basename(p).replace(/^harkroom-(runner-rs|operator-rs)-/, '');
    expect(triple(operator)).toBe(triple(runner));
  });
});
