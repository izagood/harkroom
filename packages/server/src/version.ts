import { readFileSync } from 'node:fs';
import type { ServerVersion } from '@harkroom/shared';

/**
 * 서버가 자기 버전을 말한다(#693).
 *
 * ## 왜 `packages/server/package.json` 을 안 읽는가
 *
 * 거기 적힌 `0.0.0` 은 **워크스페이스 자리채움**이다 — 이 저장소의 패키지 열 개가 전부
 * `0.0.0` 이고 전부 `private` 이라 npm 에 올라가지 않는다(`desktop/scripts/sync-version.mjs`
 * 상단에 그 근거가 적혀 있다). 그것을 화면에 띄우면 모든 서버가 영원히 `0.0.0` 이다.
 *
 * ## 정본은 `tauri.conf.json` 이고, 이미지는 그 파일을 실어 온다
 *
 * 이 저장소의 배포 버전 정본은 `packages/desktop/src-tauri/tauri.conf.json` 하나다
 * (릴리즈 워크플로가 `sync-version.mjs` 로 그것을 올리고 커밋한다). 서버가 **다른 자리**를
 * 정본으로 삼으면 그 순간 두 숫자가 갈리고, 갈린 것은 배포 뒤에야 드러난다. 그래서 서버
 * 이미지는 그 JSON 을 한 줄로 복사해 오고(`packages/server/Dockerfile`) 여기서 읽는다.
 * 데스크톱이 `vite.config.ts` 에서 같은 파일을 읽는 것과 **같은 규칙**이다.
 *
 * ## 왜 커밋 sha 를 따로 두는가
 *
 * 릴리스 하나에 커밋이 여럿 들어간다. "v0.1.174 가 돈다" 는 "머지된 그 수정이 들어 있다" 를
 * 뜻하지 않으므로, `git log` 로 따질 수 있는 값이 하나 더 필요하다. 저장소 메타(`.git`)는
 * 빌드 컨텍스트에서 빠져 있어(`.dockerignore`) 이미지 안에서는 구할 수 없다 — 그래서
 * **빌드 인자로 심는다.** 안 심었으면 `null` 이다. 지어내지 않는다.
 */

/**
 * 프로세스가 뜬 시각. **모듈 로드 때 한 번 잰다** — 요청마다 재면 그것은 "지금"이지
 * "언제 떴는지"가 아니다. 버전이 그대로인 재배포(같은 릴리스 안의 커밋을 다시 빌드)에서는
 * 이 값만이 달라지므로, 사람이 "재배포가 먹었나"를 판단하는 유일한 근거가 된다.
 */
const startedAt = new Date().toISOString();

/**
 * 정본 JSON 의 자리. 이 파일(`src/version.ts`)에서 잰다 — `process.cwd()` 로 잡으면
 * 어디서 띄웠느냐에 따라 값이 달라져, 개발자 기계에서만 `null` 이 되는 식으로 어긋난다.
 */
const TAURI_CONF = new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url);

/**
 * 릴리스 버전을 한 번만 읽는다.
 *
 * **실패해도 던지지 않는다.** 버전은 사람에게 보여 주는 사실일 뿐이라 서버가 뜨는 조건이
 * 아니다 — 못 읽었다고 기동을 막으면 화면에 숫자 하나를 띄우려다 채팅 전체를 못 쓰게 된다.
 * 못 읽은 것은 `null` 로 말한다(`ServerVersion.version` 주석).
 */
function readReleaseVersion(): string | null {
  // 환경변수를 **먼저** 본다. 이 저장소 밖에서(다른 빌드 파이프라인·셀프호스트) 띄우는
  // 사람에게 파일을 강요하지 않기 위한 탈출구다.
  const fromEnv = process.env.MURMUR_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8')) as { version?: unknown };
    return typeof conf.version === 'string' && conf.version ? conf.version : null;
  } catch {
    return null;
  }
}

const version = readReleaseVersion();
const commit = process.env.MURMUR_COMMIT?.trim() || null;

/** 이 서버의 버전 사실. 값은 프로세스가 사는 동안 바뀌지 않는다. */
export function serverVersion(): ServerVersion {
  return { version, commit, startedAt };
}
