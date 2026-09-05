#!/usr/bin/env node
// 러너를 앱과 함께 배포할 수 있는 Tauri 사이드카로 만든다(#431 1단계 B, #425·#429 를 닫는다).
//
// 지금까지 러너는 `pnpm --filter @murmur/agent start` 로 **소스를 실행**했다 — 그래서
// 사용자 기계에 저장소 체크아웃 + `node_modules` + `pnpm` + node 가 있어야 했다(`#425` 가
// clone 으로, `#429` 가 install 로 메우려다 실패했다). 이 스크립트는 그 전제를 없앤다:
// `@murmur/agent` 를 단일 파일로 번들해 앱 실행 파일과 함께 배포되는 실행 가능한
// 산출물(`src-tauri/binaries/murmur-runner-<target-triple>`)로 만든다.
//
// ## `node-pty` 는 왜 번들에 안 들어가는가
//
// 네이티브 애드온(`.node`)은 esbuild 가 JS 로 인라인할 수 없다 — 그래서 `external`로 두고,
// 번들 옆에 `node_modules/node-pty/`(코드 + `prebuilds/<platform>-<arch>/*.node`)를 통째로
// 복사한다. `node-pty` 자신의 로더(`lib/utils.js::loadNativeModule`)가 `require`/`import`
// 시점에 `./prebuilds/<platform>-<arch>`를 **번들 파일 기준 상대 경로**로 찾으므로, 그
// 로더를 다시 구현하지 않고 그대로 재사용한다 — 실측(esbuild ESM 출력 + 곁들인
// `node_modules/node-pty/`)으로 로드·spawn 이 되는 것을 확인했다.
//
// PTY 를 Rust 로 옮기는 안은 채택하지 않는다(#431 이슈 본문의 폐기 근거) — 러너가 앱에
// 더 강하게 묶여 이 이슈의 목적(앱과 러너의 결합을 줄인다)과 반대다.
//
// ## 이 산출물은 여전히 Node 런타임을 요구한다
//
// `esbuild`/`bun build`가 만드는 것은 **단일 JS 파일**이지 네이티브로 컴파일된 실행
// 파일이 아니다(Node SEA·`bun build --compile` 은 이번 1단계 범위 밖 — 검증할 시간과
// 환경이 없었다. 보고 참고). 그래서 산출물 맨 앞에 `#!/usr/bin/env node` 셔뱅을 붙이고
// 실행 비트를 세운다 — macOS·Linux 에서는 이것으로 `Command::new(path).spawn()` 이
// 셸 없이도 그대로 실행된다(커널이 셔뱅을 해석한다). **Windows 는 셔뱅을 해석하지 않는다**
// — 그 갈래는 아래에서 명시적으로 실패시킨다(추측으로 통과라고 적지 않는다. 보고 참고).
import { build } from 'esbuild';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, '..');
const repoRoot = join(desktopRoot, '..', '..');
const agentRoot = join(repoRoot, 'packages', 'agent');
const binariesDir = join(desktopRoot, 'src-tauri', 'binaries');

/**
 * Rust 쪽(target triple)과 Node 쪽(`process.platform`/`process.arch`) 명명 규칙이 다르다.
 * `node-pty` 의 prebuilds 는 후자를 쓰고(`prebuilds/darwin-arm64` 등), Tauri 의
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
  const { execFileSync } = require('node:child_process');
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const m = out.match(/^host:\s*(\S+)$/m);
  if (!m) throw new Error(`rustc -vV 출력에서 host triple 을 찾지 못했다:\n${out}`);
  return m[1];
}

async function main() {
  const triple = process.env.MURMUR_RUNNER_TARGET_TRIPLE ?? hostTargetTriple();
  const nodePlatform = TRIPLE_TO_NODE_PLATFORM[triple];
  if (!nodePlatform) {
    throw new Error(
      `target triple '${triple}' 을 알지 못한다 — TRIPLE_TO_NODE_PLATFORM 에 없다. ` +
      `이 triple 에 대응하는 node-pty prebuild 이름을 확인하고 표를 넓혀라.`,
    );
  }

  // **Windows 셔뱅 갈래(알려진 제약, #431 1단계 보고 참고)**: 셔뱅(`#!/usr/bin/env node`)은
  // POSIX exec 계열이 해석하는 관례라 Windows 커널은 그것을 실행하지 못한다. Tauri
  // `externalBin` 은 그 파일을 그대로 `Command::new(path).spawn()` 에 넘기므로, 이 스크립트가
  // Windows 대상에 지금 산출물을 그대로 내면 앱에서 조용히 스폰이 실패한다. 조용히 "됐다"고
  // 적는 대신 여기서 크게 멈춘다 — Windows 지원은 `.exe`로 감싸는 네이티브 런처(SEA 등)가
  // 필요하고 그것은 이번 1단계 범위 밖이다.
  if (nodePlatform.platform === 'win32') {
    throw new Error(
      'Windows 사이드카는 이 스크립트로 만들 수 없다 — 셔뱅 스크립트는 Windows 에서 직접 ' +
      '실행되지 않는다(POSIX exec 관례). 네이티브 런처(Node SEA 등)가 필요하고 그것은 ' +
      '#431 1단계 범위 밖이다. macOS·Linux 만 이 스크립트로 낸다.',
    );
  }

  rmSync(binariesDir, { recursive: true, force: true });
  mkdirSync(binariesDir, { recursive: true });

  const outfile = join(binariesDir, `murmur-runner-${triple}`);
  const bundleFile = `${outfile}.mjs`;

  await build({
    entryPoints: [join(agentRoot, 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: bundleFile,
    // node-pty 는 네이티브 애드온이라 번들에 못 들어간다 — 아래에서 패키지 전체를
    // 곁들여 복사하고, 런타임의 ESM import 가 그것을 표준 node_modules 해석으로 찾는다.
    external: ['node-pty'],
    // `.node` 확장자 파일 등을 오인해 번들에 끌어들이지 않게 확실히 한다.
    loader: { '.node': 'copy' },
  });

  // 셔뱅을 붙이고 하나의 실행 가능한 파일로 만든다. esbuild 출력은 셔뱅이 없다.
  const bundled = readFileSync(bundleFile, 'utf8');
  writeFileSync(outfile, `#!/usr/bin/env node\n${bundled}`);
  rmSync(bundleFile);
  chmodSync(outfile, 0o755);

  // node-pty 패키지 전체(코드 + prebuilds)를 사이드카 옆 node_modules 에 곁들인다 —
  // 사이드카 파일 기준 상대 경로가 그 로더의 계약이다(`lib/utils.js`).
  const ptyPkgDir = dirname(require.resolve('node-pty/package.json', { paths: [agentRoot] }));
  const destPtyDir = join(binariesDir, 'node_modules', 'node-pty');
  mkdirSync(dirname(destPtyDir), { recursive: true });
  cpSync(ptyPkgDir, destPtyDir, { recursive: true });

  // **prebuilds 는 요청한 target triple 것만 남긴다** — 나머지 플랫폼 것까지 배포에 실으면
  // 번들 크기만 늘고 이 빌드가 쓰지 않는다. `node-pty` 의 로더는 `process.platform`/
  // `process.arch` 로 찾으므로, 지금 host 것만 있어도 그 경로가 그대로 성립한다.
  const prebuildsDir = join(destPtyDir, 'prebuilds');
  if (existsSync(prebuildsDir)) {
    const keep = `${nodePlatform.platform}-${nodePlatform.arch}`;
    for (const entry of require('node:fs').readdirSync(prebuildsDir)) {
      if (entry !== keep) rmSync(join(prebuildsDir, entry), { recursive: true, force: true });
    }
  }

  console.log(`러너 사이드카 빌드 완료: ${outfile}`);
  console.log(`node-pty prebuild: ${nodePlatform.platform}-${nodePlatform.arch}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
