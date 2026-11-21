// 사이드카 산출물의 자리와 target triple 판정. `build-sidecars.mjs` 가 쓴다.
//
// 옛 `sidecar.mjs` 는 Node 러너·오퍼레이터를 esbuild 로 묶어 셔뱅 스크립트로 내던 공통 절차였다. 사이드카가 둘 다
// Rust(Mach-O)로 바뀐 뒤 남은 쓸모는 아래 셋뿐이라 그것만 옮겼다 — 자리(`binariesDir`), 저장소 루트, triple.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** `packages/desktop`. */
export const desktopRoot = join(here, '..');
/** 저장소 루트. */
export const repoRoot = join(desktopRoot, '..', '..');
/** 사이드카 산출물이 모이는 곳. Tauri 의 `externalBin` 이 여기서 집어 간다. */
export const binariesDir = join(desktopRoot, 'src-tauri', 'binaries');

/** 이 스크립트가 내는 triple — 호스트에서 빌드하는 것만 다룬다(크로스 컴파일은 범위 밖). */
const KNOWN_TRIPLES = new Set([
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
]);

function hostTargetTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const m = out.match(/^host:\s*(\S+)$/m);
  if (!m) throw new Error(`rustc -vV 출력에서 host triple 을 찾지 못했다:\n${out}`);
  return m[1];
}

/**
 * 이번 빌드가 겨냥하는 triple. `HARKROOM_RUNNER_TARGET_TRIPLE` 로 덮어쓸 수 있다(이름은 러너 시절부터 쓰던 것 —
 * 이미 있는 환경·문서를 깨지 않는다). `tauri build --target` 과 갈리면 다른 아키텍처가 실리므로 모르는 triple 은
 * 조용히 넘기지 않고 멈춘다. Windows 는 아직 내지 않는다.
 */
export function resolveTarget() {
  const triple = process.env.HARKROOM_RUNNER_TARGET_TRIPLE ?? hostTargetTriple();
  if (!KNOWN_TRIPLES.has(triple)) {
    throw new Error(`target triple '${triple}' 은 이 스크립트가 내지 않는다 — macOS·Linux(${[...KNOWN_TRIPLES].join(', ')})만 낸다.`);
  }
  return { triple };
}
