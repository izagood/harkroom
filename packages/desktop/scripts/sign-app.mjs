#!/usr/bin/env node
// 빌드된 `.app` 을 **고정된 서명 identifier** 로 다시 서명한다.
//
// ## 왜 필요한가 — 키체인이 매번 다시 묻는다
//
// macOS 키체인 ACL 은 앱을 **서명 identifier** 로 식별한다. 그런데 Rust 링커가 붙이는
// ad-hoc 서명(`linker-signed`)은 그 값을 **빌드 산출물 해시에서 만든다**:
//
//   번들 ID (Info.plist)        : app.murmur.desktop
//   서명 identifier (키체인이 봄) : murmur_desktop-8e22d6330b5570a5   ← 랜덤으로 보인다
//
// 실측(2026-09-06):
//   디버그 빌드 (여러 워크트리)  : murmur_desktop-2cf138358ac0eb80
//   릴리즈 .app                 : murmur_desktop-8e22d6330b5570a5
//
// **빌드 프로필이 바뀌면 키체인은 다른 앱으로 본다.** 그래서 승인 대화상자가 다시 뜨고,
// 그 대화상자는 `#450` 이전에 앱을 통째로 멎게 했다(지금은 안 멎지만 여전히 사람을 막는다).
//
// 개발 중 재빌드를 반복하는 환경에서 이것이 **직접적인 병목**이었다.
//
// ## 무엇을 하나
//
// **안쪽 Mach-O 부터 깊이 순으로 하나씩 서명하고, 마지막에 바깥 `.app` 을 서명한다.**
// ad-hoc 이면 identifier 만 번들 ID 로 고정하고(인증서 불필요), `Developer ID` 면
// hardened runtime + 타임스탬프를 얹는다.
//
// ## 왜 `--deep` 을 쓰지 않는가 — 그것이 1차 공증 거절의 원인이었다
//
// 예전 이 스크립트는 `codesign --force --deep` 하나로 끝냈다. **틀렸다.**
//
// Apple DTS(Quinn "The Eskimo!", 개발자 포럼 129980)가 정확히 이 함정을 설명한다:
//
// > `--deep` 은 **nested code site 에서만** 코드를 찾는다. **데이터가 있어야 할 자리에
// > 코드를 두면 `--deep` 은 그것을 서명하지 않는다.**
//
// `Contents/Resources` 가 바로 그 "데이터 자리"다. 우리는 거기에 `node-pty` 를 싣고,
// 그 안에는 **진짜 Mach-O 가 둘** 있다(`prebuilds/darwin-arm64/pty.node`,
// `prebuilds/darwin-arm64/spawn-helper`). `--deep` 은 그것들을 건너뛰었고, 그래서 1차
// 공증이 그대로 거절됐다(실측):
//
//   status: Invalid
//   The binary is not signed. (…/node-pty/prebuilds/darwin-arm64/pty.node)
//   The binary is not signed. (…/node-pty/prebuilds/darwin-arm64/spawn-helper)
//
// 그리고 `--deep` 은 **macOS 13 부터 서명 용도로 deprecated** 다(`man codesign`:
// "-deep … is not recommended … use it only for ad-hoc verification"). 새로 쓸 이유가 없다.
//
// **바깥 `.app` 에도 `--deep` 을 쓰지 않는다.** 같은 Quinn 의 지적: `--deep` 은 앱의
// entitlements 를 nested code 에 그대로 적용하고, 그렇게 잘못 얹힌 entitlements 는
// "trusted execution system 이 프로그램을 막을 수 있다". nested code 는 자기 서명을 이미
// 갖고 있어야 하고, 바깥 서명은 그것들을 봉인하기만 하면 된다.
//
// ## 그래서 Mach-O 를 어떻게 찾는가 — **내용으로 찾는다**
//
// 이름·확장자로 찾지 않는다(`*.node`, `spawn-helper` 같은 목록). 그 목록은 의존이 하나
// 늘거나 파일 이름이 바뀌는 순간 조용히 새는데, 그 사실은 공증 거절로 몇 분 뒤에야 온다.
//
// `file -b <경로>` 가 `Mach-O` 를 말하는지로 판정한다 — **파일 내용을 본다.** 실측으로
// 확인한 결과(이 번들, 2026-09-06): 이 방식이 `pty.node`·`spawn-helper`·`murmur-desktop`
// 셋을 찾고, 사이드카 둘(`murmur-runner`·`murmur-daemon`)은 **셔뱅 스크립트라 Mach-O 가
// 아니어서 제외된다.**
//
// ## 그렇다고 사이드카를 안 서명해도 되는 것은 아니다 — 실측으로 배운 것
//
// 처음에 "Mach-O 가 아니니 서명 대상이 아니다"로 끝냈다가 마지막 `.app` 서명에서 막혔다:
//
//   murmur.app: code object is not signed at all
//   In subcomponent: …/Contents/MacOS/murmur-runner
//
// **`codesign` 은 `Contents/MacOS/` 안의 것을 형식이 아니라 자리로 판정한다** — 그 자리에
// 있으면 nested code 이고, 자기 서명이 있어야 번들 서명이 그것을 봉인할 수 있다. 그래서
// 서명 단계가 셋이다: ① 안쪽 Mach-O(내용으로 찾는다) ② `Contents/MacOS/` 의 사이드카
// (자리로 찾는다) ③ 바깥 `.app`. 스크립트도 서명된다 — `Format=generic` 으로 detached
// 서명이 붙는다(Mach-O 처럼 파일 안에 심지 않을 뿐이다).
//
// 두 판정이 **함께** 필요한 이유가 이것이다. 내용만 보면 사이드카를 놓치고, 자리만 보면
// `Contents/Resources` 안의 `pty.node`·`spawn-helper` 를 놓친다(그것이 1차 공증 거절이다).
//
// 참조 구현: `electron/osx-sign` 의 `src/sign.ts`·`src/util.ts` — 같은 방식이다
// (내용으로 Mach-O 판별, 깊이 정렬, 개별 서명, `--deep` 없음).
//
// ## 왜 깊이 **내림차순**인가
//
// 안쪽부터 서명한다. 바깥을 먼저 서명하면 그 서명은 그 시점의 안쪽 내용을 봉인하는데,
// 그 다음 안쪽을 서명하는 순간 내용이 바뀌어 **방금 만든 바깥 서명이 깨진다**
// (`a sealed resource is missing or invalid`). 순서가 곧 정확성이다.
//
// ## 이것이 해결하지 않는 것
//
// - **Gatekeeper** — ad-hoc 서명은 다른 기계에서 열리지 않는다. 그것은
//   `Developer ID Application` 인증서 + 공증(notarization)이 필요하고 별도 사안이다
// - **다른 서명 주체로 바뀌는 경우** — 나중에 실제 인증서로 서명하면 identifier 는 같아도
//   서명 주체가 달라져 키체인이 다시 물을 수 있다. 그때는 한 번만 승인하면 된다
//
// ## 왜 Tauri 설정이 아니라 스크립트인가
//
// `bundle.macOS.signingIdentity` 는 **실제 인증서 이름**을 받는 자리다. ad-hoc(`-`)을
// 넣는 것은 그 필드의 계약이 아니고, 넣더라도 `--identifier` 를 지정할 방법이 없다.
//
// **그래서 `tauri.macos.conf.json` 에 `bundle.macOS` 서명 설정을 일부러 넣지 않았다.**
// 넣으면 `tauri build` 가 자기 방식으로 한 번 서명하고 이 스크립트가 다시 서명한다 —
// 둘 다 성공하므로 **어느 쪽이 최종인지가 산출물을 봐야만 알 수 있고**, 두 설정이 갈리면
// (예: 한쪽만 entitlements 를 붙이면) 그 어긋남은 조용하다. 서명하는 자리는 하나여야 한다.
//
// 그 하나가 여기인 이유: Tauri 는 `--identifier` 고정도, 깊이 순 개별 서명도, 내용 기반
// Mach-O 탐지도 하지 않는다 — 이 파일이 존재하는 이유 전부가 그 셋이다.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..', 'src-tauri', 'target', 'release', 'bundle', 'macos', 'murmur.app');
/** `tauri.conf.json` 의 `identifier` 와 **같아야 한다** — 그것이 번들 ID 다. */
const IDENTIFIER = 'app.murmur.desktop';
/**
 * 앱 **본체**의 entitlements. 무엇이 들었고 왜 그것뿐인지는 그 파일의 주석에 있다.
 *
 * **안쪽 Mach-O 와 사이드카에는 붙이지 않는다** — 안쪽은 자기 권한으로 도는 nested code 이고,
 * 사이드카는 셔뱅 스크립트라 서명 대상이 아니다.
 */
const ENTITLEMENTS = join(here, '..', 'src-tauri', 'entitlements.plist');

/**
 * 이 파일이 Mach-O 인가. **내용으로 판정한다** — 확장자·이름을 보지 않는다.
 *
 * 왜 내용인가: 확장자 기반 목록(`*.node`, `spawn-helper`)은 의존이 하나 늘거나 이름이
 * 바뀌면 조용히 빈다. 그 결과는 "서명 안 된 바이너리"이고 공증 거절로만 드러난다
 * (이 파일 상단의 1차 거절 실측). `file` 은 매직 넘버를 읽으므로 이름이 무엇이든 맞는다.
 *
 * `file -b` 는 파일 이름 없이 타입 설명만 준다 — 경로에 우연히 "Mach-O" 가 들어 있어
 * 오판하는 일을 없앤다. **심볼릭 링크는 따라가지 않는다**(`-h`): 번들에 링크가 없어야
 * 하는 것이 이 작업의 다른 절반이고(`#433`), 링크를 따라가면 밖의 파일을 서명하려 든다.
 */
export function isMachO(path) {
  const probe = spawnSync('file', ['-b', '-h', path], { encoding: 'utf8' });
  if (probe.status !== 0) return false;
  return `${probe.stdout ?? ''}`.includes('Mach-O');
}

/**
 * 이 디렉터리가 `.app` 번들이면 그 **주 실행 파일의 절대 경로**를, 아니면 `null`.
 *
 * `Info.plist` 의 `CFBundleExecutable` 을 읽는다 — 이름을 상수로 박으면 `productName` 이
 * 바뀌는 순간 조용히 어긋나고, 그러면 주 실행 파일이 다시 개별 서명 대상이 되어
 * 위 주석의 실패가 되살아난다.
 *
 * `plutil -extract` 로 읽는다. plist 는 XML 일 수도 바이너리일 수도 있으므로 직접 파싱하지
 * 않는다 — `plutil` 이 둘 다 안다.
 */
function bundleMainExecutable(root) {
  const plist = join(root, 'Contents', 'Info.plist');
  if (!existsSync(plist)) return null;
  const probe = spawnSync(
    'plutil',
    ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist],
    { encoding: 'utf8' },
  );
  if (probe.status !== 0) return null;
  const name = `${probe.stdout ?? ''}`.trim();
  return name ? join(root, 'Contents', 'MacOS', name) : null;
}

/**
 * `.app` 안의 **모든 Mach-O 를 깊이 내림차순으로** 돌려준다.
 *
 * 깊이 내림차순인 이유는 상단 주석 "왜 깊이 내림차순인가" 참고 — 안쪽을 먼저 서명해야
 * 바깥 서명이 깨지지 않는다. 같은 깊이 안의 순서는 의미가 없다(서로를 봉인하지 않는다).
 *
 * ## 번들의 **주 실행 파일은 제외한다** — 실측으로 배운 것
 *
 * `Contents/MacOS/<주 실행 파일>` 은 이 목록에서 뺀다. 그것을 개별로 `codesign` 하면
 * `codesign` 이 그 경로를 **번들 전체로 해석해** 안쪽을 다시 훑고, 거기서 셔뱅 사이드카를
 * 만나 그대로 실패한다(실측):
 *
 *   $ codesign --force --sign - murmur.app/Contents/MacOS/murmur-desktop
 *   murmur-desktop: code object is not signed at all
 *   In subcomponent: …/Contents/MacOS/murmur-runner
 *
 * 즉 그 자리는 "안쪽 Mach-O 하나"가 아니라 **번들 자신**이다. 그래서 마지막의 `.app`
 * 서명이 그것을 맡는다 — 이 함수가 돌려주는 것은 **번들 서명이 봉인할 nested code** 뿐이다.
 *
 * 주 실행 파일 이름은 `Info.plist` 의 `CFBundleExecutable` 에서 읽는다. 이름을 상수로
 * 박으면 `productName` 이 바뀌는 순간 조용히 어긋난다.
 *
 * **심볼릭 링크는 내려가지 않는다.** `lstat` 으로 보고 링크면 건너뛴다 — 번들 밖으로
 * 새어 나가지 않기 위해서다(그리고 링크가 있다는 것 자체가 `staple` 을 깨는 결함이다).
 */
export function machOFilesDeepestFirst(root) {
  // 번들이면 주 실행 파일을 뺀다. `.app` 이 아닌 평범한 디렉터리면(테스트가 그렇다)
  // 뺄 것이 없다 — `Info.plist` 가 없으므로 `null` 이 되고 아무것도 제외되지 않는다.
  const mainExecutable = bundleMainExecutable(root);
  /** @type {string[]} */
  const found = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      // **`lstatSync`** — 링크를 따라가지 않는다(위 주석). 사라진 파일은 조용히 건너뛴다.
      const info = lstatSync(path, { throwIfNoEntry: false });
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        walk(path);
        continue;
      }
      if (path === mainExecutable) continue; // 번들 자신 — 마지막 `.app` 서명이 맡는다.
      if (info.isFile() && isMachO(path)) found.push(path);
    }
  };
  walk(root);

  const depth = (p) => relative(root, p).split(sep).length;
  return found.sort((a, b) => depth(b) - depth(a));
}

/**
 * 서명 주체를 고른다. **`Developer ID Application` 이 설치돼 있으면 그것을 쓴다.**
 *
 * ad-hoc(`-`)은 이 기계에서만 열린다 — 다른 사람에게 주면 Gatekeeper 가 막는다.
 * `Developer ID` 로 서명하면 그 벽이 사라지고, 공증(notarization)까지 하면 경고도 없다.
 *
 * **`Apple Distribution` 은 쓰지 않는다** — App Store·TestFlight 전용이라 직접 배포하는
 * `.app` 에는 맞지 않는다. 이 기계에 그것만 있는 상태를 실측했다(2026-09-06).
 *
 * 환경변수로 강제할 수 있다(`MURMUR_SIGN_IDENTITY`) — CI 나 특정 인증서를 골라야 할 때.
 */
function pickIdentity() {
  const forced = process.env.MURMUR_SIGN_IDENTITY;
  if (forced) return { id: forced, kind: '환경변수 지정' };

  const found = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
  const line = `${found.stdout ?? ''}`
    .split('\n')
    .find((l) => l.includes('Developer ID Application'));
  if (!line) return { id: '-', kind: 'ad-hoc (이 기계에서만 열린다)' };

  // `  1) <HASH> "Developer ID Application: …"` 에서 따옴표 안을 집는다.
  const name = line.match(/"([^"]+)"/)?.[1];
  return name
    ? { id: name, kind: 'Developer ID (공증까지 하면 다른 기계에서도 열린다)' }
    : { id: '-', kind: 'ad-hoc (Developer ID 를 찾았지만 이름을 못 읽었다)' };
}

// ---------------------------------------------------------------------------
// 여기부터 실행. **`import` 되면 돌지 않는다** — 회귀선이 위의 `isMachO`·
// `machOFilesDeepestFirst` 를 그대로 재려면 이 파일을 import 할 수 있어야 하고, 그때 서명이
// 실제로 돌면 안 된다. 재는 대상과 도는 대상을 가르지 않기 위해 **함수를 복사하지 않고**
// 이 파일에서 그대로 가져간다(그것이 되돌려 RED 가 서는 전제다).
// ---------------------------------------------------------------------------
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();

function main() {
  if (process.platform !== 'darwin') {
    console.log('macOS 가 아니다 — 재서명을 건너뛴다(이 문제는 macOS 키체인 고유다).');
    process.exit(0);
  }
  if (!existsSync(APP)) {
    throw new Error(
      `서명할 .app 이 없다: ${APP}\n` +
        '먼저 `pnpm --filter @murmur/desktop tauri build --bundles app` 을 돌려라.',
    );
  }

  const { id, kind } = pickIdentity();
  const adhoc = id === '-';
  console.log(`서명 주체: ${kind}`);

  // **`Developer ID` 로 서명할 때는 hardened runtime 과 타임스탬프가 필요하다.**
  // 공증(notarization)이 그 둘을 요구하고, 없으면 업로드 단계에서 거절된다 — 서명은
  // 성공한 뒤라 원인이 멀어진다. ad-hoc 에는 둘 다 의미가 없다(공증 대상이 아니다).
  const extra = adhoc ? [] : ['--options', 'runtime', '--timestamp'];

  // **entitlements 파일이 없으면 멈춘다 — 조용히 건너뛰지 않는다.**
  //
  // 이 갈래를 명시적으로 정한 이유: 없는데 그냥 넘어가면 서명은 성공하고 공증도 통과할 수
  // 있다. 그런데 hardened runtime 이 JIT 를 막으므로 **웹뷰가 실제로 뜰 때** 문제가 나고,
  // 그때는 "entitlements 가 붙은 줄 알았는데 아니었다"를 앱 화면에서 알게 된다. 배포
  // 산출물을 만드는 스크립트가 조용히 덜 만드는 것은 그 자체로 결함이다.
  //
  // ad-hoc 서명은 예외다 — 공증 대상이 아니고 hardened runtime 도 안 붙이므로
  // (`extra` 가 비어 있다) entitlements 를 얹을 이유가 없다. 개발 중 재서명이 그 경로다.
  let entitlements = [];
  if (!adhoc) {
    if (!existsSync(ENTITLEMENTS)) {
      throw new Error(
        `entitlements 파일이 없다: ${ENTITLEMENTS}\n` +
          'hardened runtime 은 JIT 를 막고, 이 앱의 UI 는 WKWebView(JavaScriptCore) 안에서 ' +
          '돈다 — `com.apple.security.cs.allow-jit` 없이 서명하면 웹뷰가 제대로 못 뜬다.',
      );
    }
    // **형식까지 확인한다.** 바이너리 plist 나 BOM 이 있으면 공증이
    // `Embedded entitlements are invalid` 로 거절하고, macOS 10.15.4+ 에서는 아예 실행되지
    // 않는다. `plutil -lint` 가 그 둘을 여기서 잡는다 — 공증 왕복 몇 분 뒤가 아니라 지금.
    execFileSync('plutil', ['-lint', ENTITLEMENTS], { stdio: 'inherit' });
    entitlements = ['--entitlements', ENTITLEMENTS];
    console.log(`entitlements: ${relative(here, ENTITLEMENTS)} (본체에만 붙인다)`);
  }

  // ── 1) 안쪽 Mach-O 를 깊이 내림차순으로 개별 서명한다 ────────────────────────
  //
  // `--deep` 이 아니다(상단 주석). 그리고 **`--identifier` 를 주지 않는다** — 그 값은 바깥
  // 번들의 ID 이고, 안쪽 바이너리마다 자기 이름에서 나온 identifier 를 갖는 것이 맞다.
  // 여기서 번들 ID 를 강제하면 서로 다른 nested code 가 같은 identifier 를 갖게 된다.
  const nested = machOFilesDeepestFirst(APP);
  console.log(`안쪽 Mach-O ${nested.length}개를 깊이 순으로 서명한다(내용 기반 탐지):`);
  for (const path of nested) {
    console.log(`  ${relative(APP, path)}`);
    execFileSync('codesign', ['--force', '--sign', id, ...extra, path], { stdio: 'inherit' });
  }

  // ── 2) `Contents/MacOS/` 의 사이드카 — **Mach-O 가 아니어도 서명해야 한다** ───
  //
  // 이것을 실측으로 배웠다. 사이드카(`murmur-runner`·`murmur-daemon`)는 셔뱅 스크립트라
  // Mach-O 가 **아니고**, 그래서 위 1) 의 내용 기반 탐지가 올바르게 제외한다. 그런데
  // 그것만으로 끝내면 마지막 `.app` 서명이 그대로 실패한다:
  //
  //   murmur.app: code object is not signed at all
  //   In subcomponent: …/Contents/MacOS/murmur-runner
  //
  // **`codesign` 은 `Contents/MacOS/` 안의 것을 전부 nested code 로 본다** — 파일 형식이
  // 아니라 **자리**로 판정한다. 그 자리에 있으면 자기 서명을 갖고 있어야 번들 서명이
  // 그것을 봉인할 수 있다.
  //
  // 스크립트도 서명된다(실측): `Format=generic` 으로 detached 서명이 확장 속성에 붙는다.
  // Mach-O 처럼 파일 안에 심는 것이 아닐 뿐 서명 자체는 유효하다.
  //
  // **entitlements 는 주지 않는다.** 이것들을 실행하는 것은 번들 밖의 시스템 `node` 이고,
  // 그 프로세스는 자기 서명·자기 권한으로 돈다 — 여기 얹은 권한은 어차피 그쪽에 안 간다.
  const macosDir = join(APP, 'Contents', 'MacOS');
  const mainExe = bundleMainExecutable(APP);
  const sidecars = readdirSync(macosDir)
    .map((name) => join(macosDir, name))
    .filter((p) => p !== mainExe && !isMachO(p) && lstatSync(p).isFile());
  if (sidecars.length > 0) {
    console.log(`Contents/MacOS 의 사이드카 ${sidecars.length}개를 서명한다(Mach-O 는 아니다):`);
    for (const path of sidecars) {
      console.log(`  ${relative(APP, path)}`);
      execFileSync('codesign', ['--force', '--sign', id, ...extra, path], { stdio: 'inherit' });
    }
  }

  // ── 3) 마지막에 바깥 `.app` ─────────────────────────────────────────────────
  //
  // **`--deep` 없이** 서명한다. 안쪽은 방금 각자 서명됐고, 이 서명은 그것들을 봉인하기만
  // 하면 된다. `--deep` 을 여기 쓰면 앱의 entitlements 가 nested code 에 잘못 얹힌다
  // (상단 Quinn 인용).
  //
  // **entitlements 는 여기, 본체에만 붙는다.** 안쪽 Mach-O 에도 사이드카에도 안 붙였다 —
  // 그것들은 자기 권한으로 도는 nested code 이고, 앱의 권한을 물려받아야 할 이유가 없다.
  execFileSync(
    'codesign',
    ['--force', '--sign', id, '--identifier', IDENTIFIER, ...entitlements, ...extra, APP],
    { stdio: 'inherit' },
  );

  // **확인까지 한다** — `codesign` 이 성공해도 identifier 가 안 바뀌면 이 스크립트는 목적을
  // 달성하지 못한 것이다. 조용히 넘어가면 다음 사람이 "돌렸는데 왜 또 묻지"를 겪는다.
  // **`codesign -dv` 는 stderr 로 적는다.** stdout 만 읽으면 항상 빈 문자열이고, 그러면
  // 이 확인이 "identifier 가 없다"로 오판한다 — 실제로 그렇게 한 번 틀렸다(2026-09-06).
  const probe = spawnSync('codesign', ['-dv', APP], { encoding: 'utf8' });
  const out = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  const line = out.split('\n').find((l) => l.startsWith('Identifier='));
  if (line !== `Identifier=${IDENTIFIER}`) {
    throw new Error(`재서명은 됐는데 identifier 가 기대와 다르다: ${line ?? '(없음)'}`);
  }

  // **`--strict` 로 검증한다.** 개별 서명이 순서를 잘못 타면(바깥을 먼저 서명하면) 여기서
  // `a sealed resource is missing or invalid` 로 잡힌다 — 그 실패를 공증 업로드 몇 분 뒤가
  // 아니라 지금 본다. 서명 단계의 목적은 "공증에 올릴 수 있는 상태"이므로 그것을 잰다.
  execFileSync('codesign', ['--verify', '--strict', '--verbose=2', APP], { stdio: 'inherit' });

  console.log(`재서명 완료 — Identifier=${IDENTIFIER} (키체인 ACL 이 유지된다)`);
  if (!adhoc) {
    // **서명만으로는 Gatekeeper 를 통과하지 못한다.** 실측(2026-09-06):
    //   spctl -a -vvv -t exec murmur.app
    //   → rejected / source=Unnotarized Developer ID
    // 공증은 Apple 에 올려 검사받는 별도 절차이고 자격증명(App Store Connect API 키 등)이
    // 더 필요하다. **여기서 조용히 넘어가면 "서명했으니 배포된다"고 오해한다.**
    console.log('※ 공증(notarization)은 아직이다 — 다른 기계에서는 Gatekeeper 가 막는다.');
  }
}
