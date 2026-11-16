// daemon 사이드카 빌드 경로의 회귀선(#431 2단계-a).
//
// 여기서 재는 것은 **배포 형태**뿐이다. P2 이후 앱과 함께 나가는 오퍼레이터는 Rust(`harkroom-operator-rs`)
// 하나이고, 옛 Node 오퍼레이터(`packages/operator`)는 번들에 없다.
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
  it('externalBin 이 러너와 Rust 오퍼레이터를 싣고 Node 오퍼레이터는 싣지 않는다', () => {
    const externalBin = readTauriConf().bundle?.externalBin;
    expect(externalBin).toContain('binaries/harkroom-runner');
    // P2: 오퍼레이터는 Rust 하나다. 옛 Node 오퍼레이터(`binaries/harkroom-operator`)는 싣지 않는다 — 되돌리는 스위치도 없다.
    expect(externalBin).toContain('binaries/harkroom-operator-rs');
    expect(externalBin).not.toContain('binaries/harkroom-operator');
    // B4-5b: Rust 러너도 실린다. 앱은 띄우지 않는다 — 오퍼레이터가 에이전트마다 고르는 것은 B4-5c 다.
    expect(externalBin).toContain('binaries/harkroom-runner-rs');
  });

  /**
   * **`resources` 는 러너 것이다 — daemon 이 그것을 늘리면 안 된다.** `node-pty` 는
   * PTY 를 여는 러너에만 필요하고, daemon 은 프로세스를 spawn 하고 소켓으로 말할 뿐이다.
   * 리소스 항목이 늘어나면 daemon 이 쓰지도 않는 네이티브 애드온을 배포에 싣게 되고,
   * macOS 의 `Contents/Resources` 배치·서명 문제(`main.rs` 의 알려진 한계)를 daemon 까지
   * 끌고 들어간다.
   */
  it('resources 는 러너의 node-pty 하나뿐이다', () => {
    expect(readTauriConf().bundle?.resources).toEqual({
      'binaries/node_modules/node-pty': 'node_modules/node-pty',
    });
  });
});

describe('오퍼레이터 사이드카 산출물', () => {
  /**
   * P2 — `build:sidecar` 는 옛 Node 오퍼레이터를 더 내지 않는다. 산출물 디렉터리는 빌드마다 통째로 비워지므로
   * (`build-sidecars.mjs`) 여기 `harkroom-operator-<triple>` 이 있으면 누군가 그 빌드를 되살린 것이다.
   */
  it('Node 오퍼레이터 산출물이 없다', () => {
    const runner = findSidecar('harkroom-runner');
    if (!runner) {
      console.warn(`건너뜀: 사이드카가 ${BINARIES_DIR} 에 없다 — ${SKIP_HINT}`);
      return;
    }
    const nodeOperator = readdirSync(BINARIES_DIR).filter((f) => /^harkroom-operator-(?!rs-)/.test(f));
    expect(nodeOperator).toEqual([]);
  });

  /**
   * 대조군 — 러너 쪽은 **반대로** `node-pty` 를 필요로 한다. 이것이 없으면 위 검사가
   * "빌드가 아무것도 안 해서 통과"하는 경우와 구분되지 않는다.
   *
   * ## 무엇을 재는지가 `#433` 을 닫으면서 바뀌었다
   *
   * 예전에는 러너 번들에 **정적 `import ... 'node-pty'`** 가 남는지를 봤다. 지금은 남지
   * 않는다 — 그 import 가 배포 번들에서 해석되지 않는 것이 `#433` 의 결함 자체였고,
   * 러너는 이제 런타임에 위치로 찾는다(`packages/agent/src/nodePtyLoader.ts`).
   *
   * 그래서 **로더가 번들에 들어갔는지**를 본다. 재려는 것(러너는 PTY 를 열고 daemon 은
   * 열지 않는다)은 그대로이고, 그 사실이 번들에 남는 형태만 달라졌다. 옛 정규식을 그대로
   * 두면 이 대조군은 영영 RED 다 — 실제로 그렇게 한 번 깨졌다(구현 중 실측).
   */
  it('러너 번들은 node-pty 로더를 싣는다 (대조군)', () => {
    const sidecar = findSidecar('harkroom-runner');
    if (!sidecar) {
      console.warn(`건너뜀: 러너 사이드카가 ${BINARIES_DIR} 에 없다 — ${SKIP_HINT}`);
      return;
    }
    const source = readFileSync(sidecar, 'utf8');
    // 로더가 후보 경로를 조립하는 자리 — 번들에 그대로 남는다(문자열 리터럴이다).
    expect(source, '러너 번들에 node-pty 해석 경로가 있어야 한다').toContain('"node-pty"');
    expect(source, '배포 번들의 리소스 자리를 알아야 한다').toContain('Resources');
  });

  /**
   * **정적 `import` 로 되돌아가면 RED.** 그것이 `#433` 의 결함이다 — 배포 번들에서
   * `Contents/MacOS` 위로는 `node_modules` 가 없어 ESM 해석기가 그것을 못 찾고,
   * 예전에는 그 간극을 심볼릭 링크가 메웠다(그리고 그 링크가 `staple` 을 막았다).
   */
  it('러너 번들에 정적 node-pty import 가 없다 (#433)', () => {
    const sidecar = findSidecar('harkroom-runner');
    if (!sidecar) {
      console.warn(`건너뜀: 러너 사이드카가 ${BINARIES_DIR} 에 없다 — ${SKIP_HINT}`);
      return;
    }
    const source = readFileSync(sidecar, 'utf8');
    expect(source, '정적 import 는 배포 번들에서 해석되지 않는다 — 런타임 해석이어야 한다')
      .not.toMatch(/(?:^|\n)\s*import\s+[^;]*\s+from\s*["']node-pty["']/);
  });

  /**
   * 러너와 오퍼레이터가 **함께** 같은 triple 로 나온다. 갈리면 `tauri build --target` 이 다른 아키텍처를 싣는다.
   */
  it('러너와 Rust 오퍼레이터가 같은 triple 로 함께 나온다', () => {
    const runner = findSidecar('harkroom-runner');
    const operator = findSidecar('harkroom-operator-rs');
    if (!runner || !operator) {
      console.warn(`건너뜀: 사이드카가 ${BINARIES_DIR} 에 없다 — ${SKIP_HINT}`);
      return;
    }
    const triple = (p: string) => path.basename(p).replace(/^harkroom-(runner|operator-rs)-/, '');
    expect(triple(operator)).toBe(triple(runner));
  });
});
