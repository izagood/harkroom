// Tauri 사이드카(`bundle.externalBin`)를 만드는 **공통 절차**. 러너(#431 1단계 B)와
// daemon(#431 2단계 a)이 이것을 공유한다.
//
// ## 왜 공통 모듈로 뽑았는가 — 복사하면 한쪽만 고쳐진다
//
// 두 산출물이 공유하는 것은 **번들이 어떻게 실행 가능해지는가**에 관한 것 전부다:
// target triple 판정(rustc host), esbuild 번들, 셔뱅 + `chmod 755`, Windows 갈래의
// 명시적 실패. 이것들은 사이드카라는 배포 형태 자체의 성질이지 러너나 daemon 의 성질이
// 아니다 — 그래서 하나만 있어야 한다.
//
// 이 절차를 복사해 두 벌 두면 다음이 벌어진다: 언젠가 Windows 지원(네이티브 런처)이
// 들어오거나 target triple 표가 넓어질 때 **한쪽만 고쳐지고** 다른 쪽은 조용히 옛 규칙으로
// 남는다. 그리고 그 어긋남은 빌드가 성공하는 동안 아무 흔적도 남기지 않는다 — 배포된
// 앱에서 한쪽 사이드카만 스폰에 실패하는 형태로 늦게 드러난다.
//
// ## 무엇이 산출물마다 다른가
//
// `buildSidecar()` 의 파라미터가 그 목록이다:
// - **엔트리포인트** — 러너는 `packages/agent/src/main.ts`, daemon 은 `daemon/src/main.ts`
// - **산출물 이름** — `murmur-runner` / `murmur-daemon` (`externalBin` 항목 이름과 같아야 한다)
// - **곁들일 네이티브 의존** — **러너만 `node-pty`** 를 곁들인다
//
// 마지막 항목이 이 일반화의 핵심이다. **daemon 은 `node-pty` 가 필요 없다** — PTY 를 여는
// 것은 하네스를 실제로 돌리는 러너의 일이고, daemon 은 프로세스를 spawn 하고 unix 소켓으로
// 말할 뿐이다. 그래서 `nativeDeps` 를 파라미터로 받아 daemon 은 빈 배열을 준다: 네이티브
// 애드온을 안 곁들이면 `bundle.resources` 도 필요 없고(`tauri.conf.json` 의 resources 는
// 러너 것으로 그대로 둔다), Rust 쪽 `ensure_node_pty_alongside_sidecar` 의 링크 경로도
// daemon 에는 아예 관계가 없다.
//
// ## 이 산출물은 여전히 Node 런타임을 요구한다
//
// `esbuild` 가 만드는 것은 **단일 JS 파일**이지 네이티브로 컴파일된 실행 파일이 아니다
// (Node SEA·`bun build --compile` 은 범위 밖). 그래서 산출물 맨 앞에 `#!/usr/bin/env node`
// 셔뱅을 붙이고 실행 비트를 세운다 — macOS·Linux 에서는 이것으로
// `Command::new(path).spawn()` 이 셸 없이도 그대로 실행된다(커널이 셔뱅을 해석한다).
// **Windows 는 셔뱅을 해석하지 않는다** — 그 갈래는 아래에서 명시적으로 실패시킨다.
import { build } from 'esbuild';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** `packages/desktop`. */
export const desktopRoot = join(here, '..');
/** 저장소 루트. */
export const repoRoot = join(desktopRoot, '..', '..');
/** 사이드카 산출물이 모이는 곳. Tauri 의 `externalBin` 이 여기서 집어 간다. */
export const binariesDir = join(desktopRoot, 'src-tauri', 'binaries');

/**
 * Rust 쪽(target triple)과 Node 쪽(`process.platform`/`process.arch`) 명명 규칙이 다르다.
 * 네이티브 애드온의 prebuilds 는 후자를 쓰고(`prebuilds/darwin-arm64` 등), Tauri 의
 * `externalBin` 은 전자를 요구한다(`copy_binaries` 가 `-<target-triple>` 접미사를 뗀다).
 * 이 표가 그 변환이다 — **호스트에서 빌드하는 것만 다룬다**(크로스 컴파일은 이 스크립트의
 * 범위 밖이다. rustc 의 host triple 을 그대로 신뢰한다).
 */
const TRIPLE_TO_NODE_PLATFORM = {
  'aarch64-apple-darwin': { platform: 'darwin', arch: 'arm64' },
  'x86_64-apple-darwin': { platform: 'darwin', arch: 'x64' },
  'x86_64-unknown-linux-gnu': { platform: 'linux', arch: 'x64' },
  'aarch64-unknown-linux-gnu': { platform: 'linux', arch: 'arm64' },
  'x86_64-pc-windows-msvc': { platform: 'win32', arch: 'x64' },
  'aarch64-pc-windows-msvc': { platform: 'win32', arch: 'arm64' },
};

function hostTargetTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const m = out.match(/^host:\s*(\S+)$/m);
  if (!m) throw new Error(`rustc -vV 출력에서 host triple 을 찾지 못했다:\n${out}`);
  return m[1];
}

/**
 * 이번 빌드가 겨냥하는 플랫폼을 정한다. `MURMUR_RUNNER_TARGET_TRIPLE` 로 덮어쓸 수 있다
 * (이름은 러너 시절부터 쓰던 것을 유지한다 — 이미 있는 환경·문서를 깨지 않는다. 두
 * 사이드카는 같은 호스트로 함께 나가므로 triple 이 갈릴 이유가 없다).
 *
 * **Windows 갈래는 여기서 크게 멈춘다.** 셔뱅(`#!/usr/bin/env node`)은 POSIX exec 계열이
 * 해석하는 관례라 Windows 커널은 그것을 실행하지 못한다. Tauri `externalBin` 은 그 파일을
 * 그대로 `Command::new(path).spawn()` 에 넘기므로, 지금 산출물을 Windows 대상에 그대로
 * 내면 앱에서 조용히 스폰이 실패한다. 조용히 "됐다"고 적는 대신 멈춘다 — Windows 지원은
 * `.exe`로 감싸는 네이티브 런처(Node SEA 등)가 필요하고 그것은 범위 밖이다.
 *
 * **이 판정이 공통 모듈에 있는 것이 요점이다** — 러너에만 있던 이 성질을 daemon 이 그대로
 * 물려받는다. 나중에 Windows 런처가 들어오면 고칠 자리도 여기 하나다.
 */
export function resolveTarget() {
  const triple = process.env.MURMUR_RUNNER_TARGET_TRIPLE ?? hostTargetTriple();
  const nodePlatform = TRIPLE_TO_NODE_PLATFORM[triple];
  if (!nodePlatform) {
    throw new Error(
      `target triple '${triple}' 을 알지 못한다 — TRIPLE_TO_NODE_PLATFORM 에 없다. ` +
      `이 triple 에 대응하는 prebuild 이름을 확인하고 표를 넓혀라.`,
    );
  }
  if (nodePlatform.platform === 'win32') {
    throw new Error(
      'Windows 사이드카는 이 스크립트로 만들 수 없다 — 셔뱅 스크립트는 Windows 에서 직접 ' +
      '실행되지 않는다(POSIX exec 관례). 네이티브 런처(Node SEA 등)가 필요하고 그것은 ' +
      '#431 범위 밖이다. macOS·Linux 만 이 스크립트로 낸다.',
    );
  }
  return { triple, ...nodePlatform };
}

/**
 * 사이드카 하나를 만든다.
 *
 * @param {object} opts
 * @param {string} opts.name          산출물 이름. `tauri.conf.json` 의 `externalBin` 항목과 같아야 한다.
 * @param {string} opts.entry         번들 엔트리포인트(절대 경로).
 * @param {string} opts.resolveFrom   네이티브 의존을 해석할 기준 디렉터리(그 패키지 루트).
 * @param {string[]} [opts.nativeDeps] 번들 옆에 통째로 곁들일 네이티브 패키지 이름들.
 *   **비워 두는 것이 기본이다** — 곁들이는 것은 esbuild 가 인라인할 수 없는 `.node` 애드온을
 *   가진 패키지뿐이다(러너의 `node-pty`). daemon 은 그런 의존이 없으므로 비운다.
 * @param {{triple:string, platform:string, arch:string}} opts.target `resolveTarget()` 의 결과.
 */
export async function buildSidecar({ name, entry, resolveFrom, nativeDeps = [], target }) {
  mkdirSync(binariesDir, { recursive: true });

  const outfile = join(binariesDir, `${name}-${target.triple}`);
  const bundleFile = `${outfile}.mjs`;

  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: bundleFile,
    // 네이티브 애드온은 번들에 못 들어간다 — external 로 두고 아래에서 패키지 전체를
    // 곁들여 복사한다. **`nativeDeps` 가 비면 이 목록도 비고, 그러면 번들에 들어갈 수
    // 없는 것을 external 로 눈감아 주는 일 자체가 없다** — daemon 이 실수로 `node-pty` 를
    // import 하면 esbuild 가 그것을 번들에 끌어들이려다 실패한다. 그것이 원하는 동작이다.
    external: [...nativeDeps],
    // `.node` 확장자 파일 등을 오인해 번들에 끌어들이지 않게 확실히 한다.
    loader: { '.node': 'copy' },
  });

  // 셔뱅을 붙이고 하나의 실행 가능한 파일로 만든다. esbuild 출력은 셔뱅이 없다.
  const bundled = readFileSync(bundleFile, 'utf8');
  writeFileSync(outfile, `#!/usr/bin/env node\n${bundled}`);
  rmSync(bundleFile);
  chmodSync(outfile, 0o755);

  for (const dep of nativeDeps) {
    // 패키지 전체(코드 + prebuilds)를 사이드카 옆 node_modules 에 곁들인다 — 사이드카 파일
    // 기준 상대 경로가 그 로더들의 계약이다(node-pty 는 `lib/utils.js`).
    const pkgDir = dirname(require.resolve(`${dep}/package.json`, { paths: [resolveFrom] }));
    const destDir = join(binariesDir, 'node_modules', dep);
    mkdirSync(dirname(destDir), { recursive: true });
    rmSync(destDir, { recursive: true, force: true });
    cpSync(pkgDir, destDir, { recursive: true });

    // **prebuilds 는 요청한 target 것만 남긴다** — 나머지 플랫폼 것까지 배포에 실으면
    // 번들 크기만 늘고 이 빌드가 쓰지 않는다. 로더는 `process.platform`/`process.arch` 로
    // 찾으므로 지금 host 것만 있어도 그 경로가 그대로 성립한다.
    const prebuildsDir = join(destDir, 'prebuilds');
    if (existsSync(prebuildsDir)) {
      const keep = `${target.platform}-${target.arch}`;
      for (const entryName of readdirSync(prebuildsDir)) {
        if (entryName !== keep) rmSync(join(prebuildsDir, entryName), { recursive: true, force: true });
      }
    }
  }

  return { outfile };
}
