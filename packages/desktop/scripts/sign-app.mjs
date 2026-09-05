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
// `codesign --force --deep --sign - --identifier app.murmur.desktop` — **ad-hoc 서명을
// 유지한 채 identifier 만 번들 ID 로 고정한다.** 인증서가 필요 없다.
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
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..', 'src-tauri', 'target', 'release', 'bundle', 'macos', 'murmur.app');
/** `tauri.conf.json` 의 `identifier` 와 **같아야 한다** — 그것이 번들 ID 다. */
const IDENTIFIER = 'app.murmur.desktop';

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
execFileSync(
  'codesign',
  ['--force', '--deep', '--sign', id, '--identifier', IDENTIFIER, ...extra, APP],
  { stdio: 'inherit' },
);

// **확인까지 한다** — `codesign` 이 성공해도 identifier 가 안 바뀌면 이 스크립트는 목적을
// 달성하지 못한 것이다. 조용히 넘어가면 다음 사람이 "돌렸는데 왜 또 묻지"를 겪는다.
// **`codesign -dv` 는 stderr 로 적는다** — stdout 만 읽으면 항상 빈 문자열이고, 그러면
// 이 확인이 "identifier 가 없다"로 오판한다. 실제로 그렇게 한 번 틀렸다(2026-09-06).
// **`codesign -dv` 는 stderr 로 적는다.** stdout 만 읽으면 항상 빈 문자열이고, 그러면
// 이 확인이 "identifier 가 없다"로 오판한다 — 실제로 그렇게 한 번 틀렸다(2026-09-06).
const probe = spawnSync('codesign', ['-dv', APP], { encoding: 'utf8' });
const out = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
const line = out.split('\n').find((l) => l.startsWith('Identifier='));
if (line !== `Identifier=${IDENTIFIER}`) {
  throw new Error(`재서명은 됐는데 identifier 가 기대와 다르다: ${line ?? '(없음)'}`);
}
console.log(`재서명 완료 — Identifier=${IDENTIFIER} (키체인 ACL 이 유지된다)`);
if (!adhoc) {
  // **서명만으로는 Gatekeeper 를 통과하지 못한다.** 실측(2026-09-06):
  //   spctl -a -vvv -t exec murmur.app
  //   → rejected / source=Unnotarized Developer ID
  // 공증은 Apple 에 올려 검사받는 별도 절차이고 자격증명(App Store Connect API 키 등)이
  // 더 필요하다. **여기서 조용히 넘어가면 "서명했으니 배포된다"고 오해한다.**
  console.log('※ 공증(notarization)은 아직이다 — 다른 기계에서는 Gatekeeper 가 막는다.');
}
