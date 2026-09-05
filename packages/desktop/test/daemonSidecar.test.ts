// daemon 사이드카 빌드 경로의 회귀선(#431 2단계-a).
//
// 여기서 재는 것은 **배포 형태**뿐이다 — daemon 이 무엇을 하는지는 2단계-b 의 일이고,
// 이 단계가 닫는 것은 "daemon 이 앱과 함께 나가는 실행 가능한 사이드카가 된다"는 것 하나다.
//
// 무거운 빌드(esbuild + rustc)는 매 테스트 실행에서 돌리지 않는다. 그래서 이 파일은
// **산출물이 이미 있으면** 그 실물을 재고, 없으면 사람이 알아볼 이유로 건너뛴다
// (`src-tauri/src/main.rs` 의 사이드카 통합 테스트가 쓰는 것과 같은 방식이다).
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

const SKIP_HINT = '먼저 `pnpm --filter @murmur/desktop build:sidecar` 를 돌려라';

describe('tauri.conf.json — daemon 이 externalBin 에 있다 (#431 2단계-a)', () => {
  /**
   * 이것이 "daemon 이 앱과 함께 배포된다"를 성립시키는 유일한 선언이다. 빠지면
   * `tauri build` 가 daemon 을 번들에 넣지 않고, 그 사실은 배포된 앱이 daemon 을
   * 못 찾을 때 처음 드러난다.
   */
  it('externalBin 이 러너와 daemon 을 둘 다 싣는다', () => {
    const externalBin = readTauriConf().bundle?.externalBin;
    expect(externalBin).toContain('binaries/murmur-runner');
    expect(externalBin).toContain('binaries/murmur-daemon');
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

describe('daemon 사이드카 산출물 (#431 2단계-a)', () => {
  /**
   * **실물로 실행해 본다.** "셔뱅을 붙였다 + chmod 했다"를 파일 내용으로만 확인하면
   * 그 둘이 실제로 커널의 exec 를 통과하는지는 재지 않은 것이다. Tauri 의
   * `externalBin` 은 이 파일을 그대로 `Command::new(path).spawn()` 에 넘기므로,
   * 여기서 재야 하는 것은 **파일 하나를 그대로 실행할 수 있는가**다.
   *
   * 인자까지 함께 넘겨 파싱 결과가 stdout 에 나오는지 본다 — 번들에 엔트리가 제대로
   * 들어갔는지(빈 번들·엉뚱한 엔트리)를 같은 실행 하나로 가른다.
   */
  it('셔뱅 + 실행 비트로 그대로 실행되고 인자를 판다', () => {
    const sidecar = findSidecar('murmur-daemon');
    if (!sidecar) {
      console.warn(`건너뜀: daemon 사이드카가 ${BINARIES_DIR} 에 없다 — ${SKIP_HINT}`);
      return;
    }

    // 실행 비트가 실제로 서 있는가(소유자 x).
    expect(statSync(sidecar).mode & 0o100, '소유자 실행 비트').toBe(0o100);

    const out = execFileSync(sidecar, [
      '--socket', '/tmp/murmur-test/daemon-v1.sock',
      '--app-version', '9.9.9',
    ], { encoding: 'utf8' });

    expect(out).toContain('--socket=/tmp/murmur-test/daemon-v1.sock');
    expect(out).toContain('--app-version=9.9.9');
  });

  /**
   * **이 단계의 핵심 구분이다.** daemon 번들에 `node-pty` 가 섞여 들면 daemon 이
   * 사이드카 옆의 `node_modules/node-pty` 를 요구하게 되고 — 그 디렉터리는 러너를
   * 위해 존재하는 것이라 daemon 만 따로 배포되거나 러너 리소스가 정리되는 순간
   * daemon 이 뜨지 못한다. 그리고 그 실패는 배포 후에야 드러난다.
   *
   * 번들 소스에서 `node-pty` 를 import·require 하는 흔적을 직접 찾는다. 문자열
   * 존재만 보면 주석이나 이 검사 자체에 걸릴 수 있으므로 **모듈 지정자 형태**를 본다.
   */
  it('번들이 node-pty 를 요구하지 않는다', () => {
    const sidecar = findSidecar('murmur-daemon');
    if (!sidecar) {
      console.warn(`건너뜀: daemon 사이드카가 ${BINARIES_DIR} 에 없다 — ${SKIP_HINT}`);
      return;
    }
    const source = readFileSync(sidecar, 'utf8');
    expect(source, 'daemon 번들이 node-pty 를 모듈로 끌어오면 안 된다')
      .not.toMatch(/(?:from|require\(|import\()\s*["']node-pty["']/);
  });

  /**
   * 대조군 — 러너 쪽은 **반대로** node-pty 를 요구해야 한다. 이것이 없으면 위 검사가
   * "빌드가 아무것도 안 해서 통과"하는 경우와 구분되지 않는다.
   */
  it('러너 번들은 여전히 node-pty 를 요구한다 (대조군)', () => {
    const sidecar = findSidecar('murmur-runner');
    if (!sidecar) {
      console.warn(`건너뜀: 러너 사이드카가 ${BINARIES_DIR} 에 없다 — ${SKIP_HINT}`);
      return;
    }
    const source = readFileSync(sidecar, 'utf8');
    expect(source).toMatch(/(?:from|require\(|import\()\s*["']node-pty["']/);
  });

  /**
   * 두 사이드카가 **함께** 나온다. 러너만 있고 daemon 이 없는 상태는
   * `externalBin` 이 둘을 요구하므로 `tauri build` 가 실패하는 상태이고,
   * 청소 지점이 하나라는 설계(`build-sidecars.mjs` 주석)가 깨진 신호이기도 하다.
   */
  it('러너와 daemon 이 같은 triple 로 함께 나온다', () => {
    const runner = findSidecar('murmur-runner');
    const daemon = findSidecar('murmur-daemon');
    if (!runner || !daemon) {
      console.warn(`건너뜀: 사이드카가 ${BINARIES_DIR} 에 없다 — ${SKIP_HINT}`);
      return;
    }
    const triple = (p: string) => path.basename(p).replace(/^murmur-(runner|daemon)-/, '');
    expect(triple(daemon)).toBe(triple(runner));
  });
});
