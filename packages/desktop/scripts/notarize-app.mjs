#!/usr/bin/env node
// 서명된 `.app` 을 Apple 에 올려 **공증(notarization)** 받고 티켓을 앱에 박는다.
//
// ## 왜 필요한가 — 서명만으로는 Gatekeeper 를 통과하지 못한다
//
// 실측(2026-09-06). `Developer ID Application` 으로 정상 서명한 `.app` 이다:
//
//   $ spctl -a -vvv -t exec murmur.app
//   rejected
//   source=Unnotarized Developer ID
//   origin=Developer ID Application: AHJIN LEE (MG6RHDZGR3)
//
// macOS 10.15 부터 **서명 + 공증**이 함께 있어야 다른 기계에서 열린다. 서명만 있으면
// "확인되지 않은 개발자" 로 막히고, 사용자는 우클릭→열기 같은 우회를 해야 한다.
//
// 공증까지 하면 **처음 실행에서 확인 클릭조차 없다** — "인터넷에서 받은 앱" 안내만 뜨고
// 그것은 어떤 앱이든 같다.
//
// ## 자격증명 — 이 스크립트는 만들지 않는다
//
// `notarytool` 이 키체인에 저장한 프로필을 쓴다. **한 번만 만들면 된다:**
//
//   # App Store Connect API 키 (권장 — 만료·2FA 영향이 없다)
//   xcrun notarytool store-credentials murmur \
//     --key <AuthKey_XXXX.p8 경로> --key-id <Key ID> --issuer <Issuer UUID>
//
//   # 또는 앱 암호
//   xcrun notarytool store-credentials murmur \
//     --apple-id <Apple ID> --team-id MG6RHDZGR3 --password <앱 암호>
//
// **자격증명을 이 저장소에 두지 않는다.** 키체인에만 있고, 스크립트는 프로필 이름만 안다.
//
// ## 왜 zip 으로 올리나
//
// `notarytool` 은 `.app` 디렉터리를 직접 못 받는다. `ditto -c -k --keepParent` 로 싸야
// 심볼릭 링크와 권한이 보존된다 — `zip` 명령은 그것을 깨뜨린다(`#433` 이 만든
// `node_modules` 링크가 여기 걸린다).
//
// ## staple 이 마지막이다
//
// 공증이 끝나면 Apple 서버에 티켓이 생기지만, **그것만으로는 오프라인에서 안 열린다.**
// `stapler staple` 이 티켓을 앱 안에 박아야 네트워크 없이도 통과한다.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..', 'src-tauri', 'target', 'release', 'bundle', 'macos', 'murmur.app');
const PROFILE = process.env.MURMUR_NOTARY_PROFILE ?? 'murmur';

if (process.platform !== 'darwin') {
  console.log('macOS 가 아니다 — 공증을 건너뛴다.');
  process.exit(0);
}
if (!existsSync(APP)) {
  throw new Error(`공증할 .app 이 없다: ${APP}\n먼저 빌드하고 \`pnpm sign\` 을 돌려라.`);
}

// **서명부터 확인한다.** 서명이 없거나 ad-hoc 이면 공증은 반드시 실패하는데, 그 실패는
// 업로드를 기다린 뒤에 온다(수 분). 여기서 먼저 막으면 그 시간을 안 쓴다.
const probe = spawnSync('codesign', ['-dv', APP], { encoding: 'utf8' });
const info = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
if (!info.includes('TeamIdentifier=') || info.includes('TeamIdentifier=not set')) {
  throw new Error(
    'ad-hoc 서명이거나 서명이 없다 — 공증은 `Developer ID` 서명을 요구한다.\n' +
      '`pnpm --filter @murmur/desktop sign` 을 먼저 돌려라(인증서가 설치돼 있어야 한다).',
  );
}
if (!info.includes('flags=0x10000(runtime)')) {
  throw new Error('hardened runtime 이 없다 — 공증이 거절한다. `sign` 스크립트를 다시 돌려라.');
}

const work = mkdtempSync(join(tmpdir(), 'murmur-notarize-'));
const zip = join(work, 'murmur.zip');
try {
  console.log('압축 중(ditto — 링크·권한 보존)…');
  execFileSync('ditto', ['-c', '-k', '--keepParent', APP, zip], { stdio: 'inherit' });

  console.log(`Apple 에 올리는 중(프로필 ${PROFILE}) — 몇 분 걸린다…`);
  execFileSync(
    'xcrun',
    ['notarytool', 'submit', zip, '--keychain-profile', PROFILE, '--wait'],
    { stdio: 'inherit' },
  );

  console.log('티켓을 앱에 박는 중(staple)…');
  execFileSync('xcrun', ['stapler', 'staple', APP], { stdio: 'inherit' });
} finally {
  rmSync(work, { recursive: true, force: true });
}

// **확인까지 한다.** `stapler` 가 성공해도 Gatekeeper 가 통과시키는지는 별개다 —
// 그것이 이 스크립트의 목적이므로 목적 자체를 잰다.
const verdict = spawnSync('spctl', ['-a', '-vvv', '-t', 'exec', APP], { encoding: 'utf8' });
const out = `${verdict.stdout ?? ''}${verdict.stderr ?? ''}`;
if (!out.includes('accepted')) {
  throw new Error(`공증은 끝났는데 Gatekeeper 가 여전히 막는다:\n${out}`);
}
console.log(`공증 완료 — Gatekeeper 통과.\n${out.trim()}`);
