// `node-pty` 를 **런타임에 위치로 찾아** 해석한다. 정적 `import` 를 쓰지 않는 이유가
// 이 파일의 존재 이유 전부다.
//
// ## 왜 정적 import 를 못 쓰는가 — 배포 번들에서 두 자리가 갈린다
//
// 러너는 esbuild 가 만든 **단일 ESM 파일**이고, 거기 남는 `import pty from 'node-pty'` 는
// Node 의 ESM 해석기가 **그 파일이 있는 디렉터리에서 위로 `node_modules` 를 걸어 올라가며**
// 찾는다. 그런데 Tauri 는 두 산출물을 다른 자리에 둔다:
//
//   externalBin        → murmur.app/Contents/MacOS/murmur-runner
//   bundle.resources   → murmur.app/Contents/Resources/node_modules/node-pty
//
// `Contents/MacOS` 위로는 `node_modules` 가 없으므로 정적 import 는 그대로 실패한다.
// 개발 빌드(`target/debug/`)에서만 두 자리가 우연히 같아 통했다(`tauri-utils` 의
// `platform::resource_dir_from` 이 cargo output 디렉터리를 감지하면 `exe_dir` 을 그대로
// 리소스 디렉터리로 돌려준다).
//
// ## 왜 심볼릭 링크가 아닌가 — `staple` 이 그것을 거절한다 (`#433` 의 예고가 온 자리)
//
// 이전에는 Rust 쪽(`main.rs::ensure_node_pty_alongside_sidecar`)이 앱이 뜰 때
// `Contents/MacOS/node_modules → <절대경로>/Contents/Resources/node_modules` 심볼릭 링크를
// 만들어 두 자리를 이었다. **서명·공증이 들어오면서 그 방식이 끝났다.** 실측:
//
//   xcrun notarytool submit → status: Accepted   ← 공증 자체는 통과한다
//   xcrun stapler staple    → rejected (invalid destination for symbolic link in bundle)
//
// 번들 **바깥**을 가리키는(그리고 기계마다 달라지는 절대 경로인) 링크를 `stapler` 가
// 거부한다. 공증 티켓을 앱에 박지 못하면 오프라인에서 Gatekeeper 를 통과하지 못하므로,
// "공증은 됐다"는 것만으로는 배포가 성립하지 않는다. 그리고 번들 안에 파일을 만드는 것은
// 애초에 봉인된 리소스를 깨뜨린다(`a sealed resource is missing or invalid`).
//
// 그래서 **번들에 아무것도 쓰지 않는다.** 대신 러너가 자기 위치에서 리소스 자리를 계산해
// 직접 해석한다 — `#433` 주석이 예고한 "사이드카가 리소스 경로에서 `node-pty` 를 직접
// 해석하도록 로더를 넣는" 안이다.
//
// ## 왜 `NODE_PATH` 가 아닌가
//
// **`NODE_PATH` 는 ESM 해석기가 무시한다**(CommonJS 전용). 실측(Node 24.3.0): `node_modules`
// 를 `NODE_PATH` 로 가리켜도 정적 `import` 는 그대로 `ERR_MODULE_NOT_FOUND` 다. 러너 번들은
// ESM 이므로 이 경로는 아예 성립하지 않는다.
//
// ## 왜 경로를 인자·환경변수로 받지 않는가 — `#431` 3/3 의 경계
//
// 받아도 되는 것처럼 보이지만 받지 않는다. `node-pty` 경로는 **실행 표면**이다 — 그 경로가
// 정해지면 이 프로세스가 어떤 네이티브 코드를 `dlopen` 할지가 정해진다. `#431` 3/3 은 그런
// 값을 웹뷰가 고르지 못하게 하는 것을 성질로 못박았고, 러너에 오는 값은 앱을 거쳐 온다.
//
// **자기 위치에서 계산하면 아무도 고를 수 없다.** 이것이 Rust 가 계산해 넘기는 안보다도
// 좁다 — 넘기는 순간 그 인자는 프로세스 경계를 건너는 값이 되고, 누가 넘기는지를 다시
// 지켜야 한다. 여기서는 넘기는 자리 자체가 없다.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as NodePty from 'node-pty';

/**
 * `node-pty` 패키지 디렉터리 후보들. **순서가 의미를 가진다** — 앞이 개발, 뒤가 배포다.
 *
 * @param sidecarDir 러너 실행 파일이 있는 디렉터리.
 *
 * 1. `<사이드카>/node_modules/node-pty` — 개발 빌드. `build-sidecars.mjs` 가 사이드카 옆에
 *    직접 둔다(`src-tauri/binaries/node_modules/node-pty`), 그리고 `cargo-tauri` 가 그것을
 *    `target/<profile>/` 로 함께 복사한다.
 * 2. `<사이드카>/../Resources/node_modules/node-pty` — macOS 배포 번들. `Contents/MacOS` 에서
 *    한 칸 올라가 `Contents/Resources` 로 들어간다.
 *
 * **개발을 먼저 보는 이유**: 개발 빌드에서는 1번이 실물이고 2번은 없다. 배포 번들에서는
 * 1번이 없고 2번이 실물이다 — 겹치지 않으므로 순서가 결과를 바꾸지 않지만, 앞을 개발로
 * 두면 개발 중 리소스 쪽에 남은 옛 사본을 실수로 집는 일이 없다.
 */
export function nodePtyCandidates(sidecarDir: string): string[] {
  return [
    join(sidecarDir, 'node_modules', 'node-pty'),
    join(sidecarDir, '..', 'Resources', 'node_modules', 'node-pty'),
  ];
}

/**
 * 후보 중 **실제로 있는** 첫 번째를 고른다. 없으면 `null`.
 *
 * `package.json` 이 있는지로 판정한다 — 디렉터리만 보면 빈 껍데기(옛 빌드가 남긴 것,
 * 실패한 복사)도 통과하고, 그러면 `createRequire` 가 훨씬 뒤에서 알아보기 어려운 이유로
 * 죽는다. 패키지의 정본은 `package.json` 이므로 그것을 잰다.
 */
export function findNodePtyDir(sidecarDir: string): string | null {
  return nodePtyCandidates(sidecarDir).find((dir) => existsSync(join(dir, 'package.json'))) ?? null;
}

/**
 * `node-pty` 를 해석해 돌려준다. **`createRequire` 를 쓴다.**
 *
 * `node-pty` 는 CommonJS 패키지다(`package.json` 의 `main: ./lib/index.js`). 그래서
 * `createRequire` 로 그냥 불러올 수 있고, 그 안의 네이티브 로더
 * (`lib/utils.js::loadNativeModule`)는 **자기 파일 기준 상대 경로**로
 * `prebuilds/<platform>-<arch>/pty.node` 를 찾으므로 패키지가 어느 디렉터리에 있든 그대로
 * 성립한다 — 우리가 옮긴 것은 패키지의 위치이지 패키지 **안**의 배치가 아니다.
 *
 * 실측으로 확인했다: 사이드카 트리 바깥의 임의 디렉터리에 있는 실물 `node-pty` 를 이 방식으로
 * 불러 `spawn` 까지 돌렸고, 네이티브 애드온과 `spawn-helper` 가 정상 동작했다.
 *
 * **동기 함수인 이유**: 이것이 `pty.spawn` 을 부르기 직전에 필요한 값이고, `import()` 로
 * 비동기로 만들면 `runPtyTurn` 의 동기 경로(사전 검사 → spawn)가 통째로 비동기로 번진다.
 * `createRequire` 는 동기이므로 그럴 이유가 없다.
 *
 * 후보 둘이 모두 비면 **Node 의 통상 해석으로 한 번 더** 시도한다 — 소스에서 그대로 도는
 * 경우(테스트·`tsx`)를 위해서다. 자세한 근거는 그 갈래의 주석에 있다.
 *
 * @throws 어느 방법으로도 못 찾으면 **어디를 봤는지 적어서** 던진다. 이 실패는 배포 배치가
 *   틀어졌을 때만 나는데, 그때 "못 찾았다"만 있으면 어느 자리를 고쳐야 할지 알 수 없다.
 */
export function loadNodePty(sidecarDir: string): typeof NodePty {
  const dir = findNodePtyDir(sidecarDir);
  if (dir === null) {
    // ── 소스에서 그대로 돌 때(테스트·`tsx`) ────────────────────────────────────
    //
    // 위 두 후보는 **번들된 사이드카**의 배치다. 그런데 이 모듈은 `packages/agent/src/`
    // 에서 그대로 돌기도 한다(`vitest`, `pnpm start` 의 `tsx`). 그때는 `node-pty` 가
    // 워크스페이스의 평범한 의존이고, Node 의 통상적인 `node_modules` 위로 걷기가 그것을
    // 찾는다 — 후보 경로를 더 늘릴 일이 아니라 **기본 해석에 맡기면 되는 자리**다.
    //
    // `import.meta.url` 기준으로 `createRequire` 를 만들면 그 걷기가 이 파일 위치에서
    // 시작하므로, 소스에서 돌든 설치된 패키지에서 돌든 워크스페이스의 `node-pty` 를 집는다.
    // **번들에서는 이 갈래가 서지 않는다** — esbuild 가 `node-pty` 를 external 로 두므로
    // 번들 옆·리소스 자리에 실제로 있어야 하고, 그 둘은 위에서 이미 봤다.
    try {
      return createRequire(import.meta.url)('node-pty') as typeof NodePty;
    } catch {
      // 통상 해석도 실패했다 — 아래에서 후보를 적어 던진다(그쪽이 훨씬 유용한 메시지다).
    }
    throw new Error(
      `node-pty 를 찾지 못했다 — 다음을 봤다:\n` +
        nodePtyCandidates(sidecarDir)
          .map((c) => `  ${c}`)
          .join('\n') +
        `\n개발 빌드면 \`pnpm --filter @murmur/desktop build:sidecar\` 를 돌려라. ` +
        `배포 번들이면 \`tauri.conf.json\` 의 \`bundle.resources\` 가 ` +
        `\`binaries/node_modules/node-pty\` 를 싣는지 확인하라.`,
    );
  }
  // `package.json` 을 기준으로 삼는다 — 디렉터리 경로를 그대로 주면 `createRequire` 가
  // 그것을 **파일**로 보고 부모에서 해석을 시작해, `node-pty` 자신을 못 볼 수 있다.
  const require = createRequire(join(dir, 'package.json'));
  return require(dir) as typeof NodePty;
}

/**
 * 이 실행 파일이 있는 디렉터리. 사이드카는 **번들된 단일 파일**이므로 이것이 곧 사이드카
 * 디렉터리다.
 *
 * `process.argv[1]` 이 아니라 `import.meta.url` 을 쓴다 — `argv[1]` 은 심볼릭 링크나 상대
 * 경로로 들어올 수 있고, 우리가 알아야 하는 것은 "이 모듈 파일이 실제로 어디 있는가"다.
 */
export function sidecarDirFromModule(moduleUrl: string): string {
  return dirname(fileURLToPath(moduleUrl));
}
