#!/usr/bin/env node
// 배포 버전이 **한 곳에서 나오게** 한다. 읽으면 지금 값을, 인자를 주면 그 값으로 맞춘다.
//
//   node scripts/sync-version.mjs          → 정본 버전을 찍는다(읽기)
//   node scripts/sync-version.mjs 0.2.0    → 세 자리를 그 값으로 맞춘다(쓰기)
//   node scripts/sync-version.mjs --check   → 세 자리가 이미 일치하는지만 재고, 아니면 실패
//
// ## 정본은 `tauri.conf.json` 이다 — 이 저장소가 이미 그렇게 정해 뒀다
//
// synapse 는 루트 `package.json` 이 정본이지만 **murmur 는 다르고, 그 차이에 근거가 있다.**
//
//   1. **`vite.config.ts` 가 이미 그렇게 적어 뒀다.** 화면에 뜨는 버전
//      (`__APP_VERSION__` → 설정 화면·Updates 화면)은 `tauri.conf.json` 을 읽어서 만든다:
//
//        // 배포 버전은 tauri.conf.json 이 정본이다 — package.json 의 0.0.0 은
//        // 워크스페이스 표기일 뿐이다.
//
//      정본을 다른 데로 옮기면 **이미 있는 그 결정을 뒤집는** 것이고, 그러면 화면이
//      읽는 자리와 릴리즈가 쓰는 자리가 갈린다.
//
//   2. **`packages/desktop/package.json` 의 `0.0.0` 은 어긋난 것이 아니다.** 이 워크스페이스의
//      **열 개 패키지가 전부 `0.0.0`** 이다(실측). 전부 `private: true` 라 npm 에 올라가지
//      않으므로 그 필드는 pnpm 이 요구하는 자리채움일 뿐이다. 데스크톱만 올려 두면
//      혼자 다른 규칙이 되고, "왜 이것만 다르지"가 남는다.
//
//   3. **루트 `package.json` 에는 `version` 필드가 아예 없다.** synapse 의 정본을 그대로
//      옮기려면 없는 필드를 새로 만들어야 하는데, 그것은 근거 없이 표면을 하나 더 늘리는
//      일이다. 이미 값을 갖고 있고 이미 정본으로 쓰이는 자리가 있다.
//
//   4. **`tauri.conf.json` 이 실제로 산출물 이름을 정한다.** `.dmg` 파일 이름
//      (`Harkroom_0.1.0_aarch64.dmg`)과 `Info.plist` 의 `CFBundleShortVersionString` 이
//      거기서 나온다. 다른 곳을 정본으로 삼으면 "정본"과 "실제로 배포되는 숫자"가 갈릴 수
//      있고, 그 어긋남은 릴리즈 자산 이름을 봐야만 드러난다.
//
// ## 그래서 무엇을 맞추는가 — 셋이다
//
//   packages/desktop/src-tauri/tauri.conf.json   ← **정본.** 읽을 때 이것을 읽는다
//   packages/desktop/src-tauri/Cargo.toml        ← 크레이트 버전
//   packages/desktop/src-tauri/Cargo.lock        ← `harkroom-desktop` 항목
//
// `Cargo.lock` 까지 맞추는 이유는 빌드가 어차피 그것을 갱신하기 때문이다 — 안 맞춰 두면
// 릴리즈 빌드마다 lock 이 더럽혀져 diff 노이즈가 생긴다(synapse 가 같은 이유로 그렇게 한다).
//
// **`package.json` 들은 건드리지 않는다.** 위 2 번 — 그것들은 워크스페이스 자리채움이다.
//
// ## 왜 스크립트인가 — 셋 중 하나만 갱신되는 실수가 이미 일어난다
//
// 워크플로 안에 `sed` 세 줄로 흩어 두면 그것을 잴 방법이 없다. 여기 모아 두면
// **회귀선이 실제로 돌려 보고 셋이 같아지는지 잴 수 있다**(`test/syncVersion.test.ts`).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = join(here, '..', 'src-tauri');

/** **정본.** 읽을 때 이 파일에서 읽는다. */
export const TAURI_CONF = join(tauriDir, 'tauri.conf.json');
export const CARGO_TOML = join(tauriDir, 'Cargo.toml');
export const CARGO_LOCK = join(tauriDir, 'Cargo.lock');

/** `Cargo.lock` 안에서 버전을 맞출 크레이트. `Cargo.toml` 의 `[package] name` 과 같다. */
const CRATE = 'harkroom-desktop';

/** `X.Y.Z`. Tauri 가 요구하는 형식이고(semver), `.dmg` 이름에 그대로 들어간다. */
const SEMVER = /^\d+\.\d+\.\d+$/;

/** 정본에 적힌 버전. */
export function readVersion(root = tauriDir) {
  const conf = JSON.parse(readFileSync(join(root, 'tauri.conf.json'), 'utf8'));
  return conf.version;
}

/**
 * 세 자리에서 읽은 버전을 그대로 돌려준다 — **맞추지 않고 재기만 한다.**
 *
 * 반환값이 객체인 이유: 어긋났을 때 "어디가 무엇인지"를 말해야 고칠 수 있다. `false` 하나만
 * 돌려주면 사람이 세 파일을 다시 열어야 한다.
 */
export function readAll(root = tauriDir) {
  const tauri = JSON.parse(readFileSync(join(root, 'tauri.conf.json'), 'utf8')).version;

  const cargoToml = readFileSync(join(root, 'Cargo.toml'), 'utf8');
  // `[package]` 바로 아래 첫 `version` 만 본다. 아래쪽 `[dependencies]` 에도
  // `version = "2"` 같은 줄이 널려 있어서, 전역 매치는 엉뚱한 것을 집는다.
  const cargo = cargoToml.match(/^version = "([^"]+)"/m)?.[1];

  const lockText = readFileSync(join(root, 'Cargo.lock'), 'utf8');
  // `name = "harkroom-desktop"` **다음 줄**의 version. lock 은 크레이트마다 같은 모양의
  // 블록이 반복되므로 이름으로 자리를 잡지 않으면 남의 버전을 집는다.
  const lock = lockText.match(new RegExp(`^name = "${CRATE}"\\nversion = "([^"]+)"`, 'm'))?.[1];

  return { tauri, cargo, lock };
}

/** 세 자리가 모두 같은가. 다르면 무엇이 다른지 담아 돌려준다. */
export function checkAll(root = tauriDir) {
  const found = readAll(root);
  const values = Object.values(found);
  const ok = values.every((v) => v !== undefined && v === found.tauri);
  return { ok, found };
}

/**
 * 세 자리를 `version` 으로 맞춘다.
 *
 * **형식을 먼저 확인하고 멈춘다.** 빈 문자열이나 `v0.2.0` 같은 값을 그대로 쓰면 파일 셋이
 * 조용히 망가지고, 그 사실은 몇 분 뒤 `tauri build` 나 `cargo` 파싱 실패로 온다 —
 * 원인에서 멀어진 자리다.
 */
export function writeAll(version, root = tauriDir) {
  if (!SEMVER.test(version)) {
    throw new Error(`버전 형식이 X.Y.Z 가 아니다: ${JSON.stringify(version)}`);
  }

  const confPath = join(root, 'tauri.conf.json');
  const conf = readFileSync(confPath, 'utf8');
  // **`JSON.parse` → `JSON.stringify` 로 다시 쓰지 않는다.** 그렇게 하면 값 하나만 바꿔도
  // 파일 전체가 재직렬화되어 서식이 통째로 갈린다 — 실측(이 스크립트를 처음 쓴 직후):
  // 한 줄만 바뀌어야 할 자리에서 **25 줄이 바뀌었다**. `icon` 배열과 `windows` 항목이
  // 한 줄로 적혀 있는데 `JSON.stringify(_, null, 2)` 가 그것을 여러 줄로 펼쳤기 때문이다.
  //
  // 그 노이즈는 매 릴리즈 커밋(`chore(release): vX.Y.Z`)마다 반복되고, 사람이 이 파일을
  // 손으로 고친 서식을 조용히 되돌린다. 이 스크립트가 존재하는 이유가 diff 를 깨끗하게
  // 두는 것이므로 **정확히 그 한 줄만** 바꾼다.
  //
  // 최상위 `"version"` 은 이 파일에서 유일하다(중첩된 곳에 같은 키가 없다) — 그래서
  // 줄머리 들여쓰기 두 칸으로 자리를 잡으면 애매함이 없다.
  const nextConf = conf.replace(/^ {2}"version": "[^"]+"/m, `  "version": "${version}"`);
  if (nextConf === conf && !new RegExp(`^ {2}"version": "${version}"`, 'm').test(conf)) {
    throw new Error(`tauri.conf.json 에서 최상위 version 줄을 찾지 못했다: ${confPath}`);
  }
  writeFileSync(confPath, nextConf);

  const tomlPath = join(root, 'Cargo.toml');
  const toml = readFileSync(tomlPath, 'utf8');
  // **첫 번째 것만 바꾼다.** 아래 `[dependencies]` 의 `version = "2"` 들을 함께 바꾸면
  // 의존 버전이 통째로 망가진다. `replace` 에 문자열을 주면 첫 매치만 바뀐다.
  const nextToml = toml.replace(/^version = "[^"]+"/m, `version = "${version}"`);
  if (nextToml === toml && !toml.includes(`version = "${version}"`)) {
    throw new Error(`Cargo.toml 에서 [package] version 줄을 찾지 못했다: ${tomlPath}`);
  }
  writeFileSync(tomlPath, nextToml);

  const lockPath = join(root, 'Cargo.lock');
  const lock = readFileSync(lockPath, 'utf8');
  const nextLock = lock.replace(
    new RegExp(`(^name = "${CRATE}"\\nversion = )"[^"]+"`, 'm'),
    `$1"${version}"`,
  );
  if (nextLock === lock && !new RegExp(`^name = "${CRATE}"\\nversion = "${version}"`, 'm').test(lock)) {
    throw new Error(`Cargo.lock 에서 ${CRATE} 항목을 찾지 못했다: ${lockPath}`);
  }
  writeFileSync(lockPath, nextLock);

  return version;
}

// ---------------------------------------------------------------------------
// 여기부터 실행. **`import` 되면 돌지 않는다** — 회귀선이 위 함수들을 그대로 재려면 이 파일을
// import 할 수 있어야 하고, 그때 파일이 실제로 쓰이면 안 된다(`sign-app.mjs` 와 같은 규칙).
// ---------------------------------------------------------------------------
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();

function main() {
  const arg = process.argv[2];

  if (!arg) {
    // 읽기. 워크플로가 `$(node scripts/sync-version.mjs)` 로 현재 버전을 집는다 —
    // 그래서 **버전만** 찍는다(설명을 섞으면 그 치환이 깨진다).
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

  if (arg === '--check') {
    const { ok, found } = checkAll();
    if (ok) {
      console.log(`버전이 일치한다: ${found.tauri}`);
      return;
    }
    console.error('버전이 어긋났다:');
    console.error(`  tauri.conf.json : ${found.tauri ?? '(못 읽음)'}`);
    console.error(`  Cargo.toml      : ${found.cargo ?? '(못 읽음)'}`);
    console.error(`  Cargo.lock      : ${found.lock ?? '(못 읽음)'}`);
    console.error(`고치려면: node ${'scripts/sync-version.mjs'} ${found.tauri}`);
    process.exit(1);
  }

  writeAll(arg);
  const { found } = checkAll();
  console.log(`버전을 ${arg} 로 맞췄다:`);
  console.log(`  tauri.conf.json : ${found.tauri}`);
  console.log(`  Cargo.toml      : ${found.cargo}`);
  console.log(`  Cargo.lock      : ${found.lock}`);
}
