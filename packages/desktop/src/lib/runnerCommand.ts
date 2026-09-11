/**
 * 사람이 **손으로** 러너를 띄울 때 쓰는 명령의 정본(`#431` 1단계·`#494`).
 *
 * ## 왜 이 파일이 생겼나 — 화면의 명령이 낡아 있었다
 *
 * 설정 → 에이전트 화면은 오랫동안 이렇게 안내했다:
 *
 * ```
 * MURMUR_PAT=<발급한 토큰> pnpm --filter @harkroom/agent start
 * ```
 *
 * **그 명령은 이제 대부분의 사람에게 실패한다.** `#431` 1단계가 러너를 단일 번들로 만들어
 * Tauri 사이드카(`externalBin`)로 앱과 함께 배포하도록 바꿨고(`tauri.conf.json` 의
 * `externalBin: ["binaries/harkroom-runner", …]`), `#494` 의 릴리즈 워크플로가 그 번들을
 * `.dmg` 로 내보내기 시작했다. 즉 **앱을 설치해 쓰는 사람은 murmur 저장소를 클론하지
 * 않는다** — `pnpm --filter @harkroom/agent start` 는 그 사람의 머신에서 실행할 소스도,
 * `pnpm` 워크스페이스도 없다.
 *
 * 그런데 그 문구는 **클립보드에 복사되는 값**이었다(`#125` 가 "잘리지 않는 완성된 명령"을
 * 보장하려고 넣은 복사 버튼). 사람은 그것을 그대로 붙여넣는다. 완성된 모양의 명령이
 * 붙여넣는 순간 실패하는 것이 이 파일이 없애는 상태다.
 *
 * ## 손으로 띄우는 길이 여전히 남아 있는 이유 — 그래서 절을 지우지 않았다
 *
 * `#482`(A안)로 앱이 daemon 을 먼저 세우고 러너를 spawn 하게 됐지만, 앱이 띄우는 대상은
 * **`ownerAccountId` 가 내 계정인 에이전트뿐**이다(`runnerLauncher.ts::doStartOne` 의
 * 대상 판정). 남이 소유했거나 소유자가 없는 에이전트, 그리고 **이 앱이 안 도는 머신**에
 * 붙일 러너는 지금도 사람이 띄운다. 그래서 안내는 남고 **명령만 바뀐다.**
 *
 * ## 두 갈래를 모두 적는다 — 하나만 적으면 반쪽이 또 낡는다
 *
 * | 상황 | 명령 |
 * |---|---|
 * | 앱을 설치해 쓴다(배포판) | `.app` 안 사이드카 절대 경로 |
 * | murmur 저장소를 클론해 개발한다 | `pnpm --filter @harkroom/agent start` |
 *
 * 아래쪽(pnpm)은 **죽은 명령이 아니다** — `packages/agent/package.json` 의 `start` 스크립트가
 * 그대로 있고 저장소 안에서는 지금도 돈다. 낡은 것은 "그것이 **유일한** 길이다"라는 전제였다.
 * 그래서 지우지 않고 **개발 환경 전용이라는 조건을 붙여** 아래 갈래로 내렸다.
 *
 * ## 사이드카 경로가 이 모양인 근거
 *
 * Tauri 의 `externalBin` 번들링은 `<name>-<target-triple>` 을 `<name>` 으로 이름을 바꿔
 * **앱 실행 파일과 같은 디렉터리**에 복사한다(`tauri-build::copy_binaries`). 그 디렉터리가
 * macOS `.app` 에서는 `Contents/MacOS/` 다 — Rust 쪽 `sidecar_path()` 가 `current_exe()` 의
 * 부모를 그대로 쓰는 것과 **같은 규칙**이고, daemon 의 `defaultRunnerCommand()`(러너를
 * daemon 실행 파일 옆에서 찾는다)도 같은 자리를 가리킨다.
 *
 * 앱 이름은 `tauri.conf.json` 의 `productName`(`murmur`)이 정한다. 사람이 앱을 어디에
 * 설치했는지는 앱이 알 수 없으므로 `/Applications` 를 **예시로만** 적는다.
 *
 * ## `MURMUR_URL` 을 함께 적는 이유
 *
 * 러너의 기본 서버 주소는 `http://localhost:3400` 이다(`packages/agent/src/config.ts`).
 * 다른 머신에서 손으로 띄우는 사람에게 그 기본값은 거의 항상 틀리다 — 빠뜨리면 러너가
 * 자기 로컬호스트에 붙으려다 실패하고, 그 실패는 "PAT 가 틀렸나"로 오독된다.
 *
 * **실값이 아니라 자리표시로 적는다.** 이 화면은 이 앱이 붙어 있는 서버를 알지만, 손으로
 * 러너를 띄우는 상황은 *"이 앱이 안 도는 머신에서 띄운다"* 가 대부분이라 그 머신에서
 * 서버에 닿는 주소가 이 앱의 것과 같다는 보장이 없다(로컬호스트가 대표적이다). 아는
 * 척하는 주소를 박아 넣으면 그것이 또 하나의 조용한 거짓말이 된다.
 */

import type { Translate } from '../i18n';

/** 러너 사이드카의 실행 파일 이름. Rust 의 `RUNNER_SIDECAR_NAME` 과 같은 값이다. */
export const RUNNER_SIDECAR_NAME = 'harkroom-runner';

/**
 * `.app` 안 러너 사이드카의 경로. 설치 위치는 사람마다 다르므로 `/Applications` 는 예시다.
 * `productName` 이 `murmur` 이라 번들 이름이 `Harkroom.app` 이 된다.
 */
export const RUNNER_SIDECAR_PATH =
  `/Applications/Harkroom.app/Contents/MacOS/${RUNNER_SIDECAR_NAME}`;

/** 저장소를 클론해 개발할 때 쓰는 명령. 배포판에는 이 소스가 없다. */
export const RUNNER_DEV_COMMAND = 'pnpm --filter @harkroom/agent start';

/**
 * 서버 주소 자리표시. 사람이 자기 머신에서 서버에 닿는 주소로 바꿔 쓴다.
 *
 * **사전을 안 지난다.** 이것은 화면 문구가 아니라 **셸 명령 안의 자리표시**이고,
 * 클립보드에 그대로 실려 나간다(`#125`: 화면의 명령과 복사되는 명령이 글자 하나까지
 * 같아야 한다). `agents` 머리말이 `/Users/me/some-repo`·`team-name` 에 대해 세운 규율
 * 그대로다 — 번역하면 사람이 그것을 **입력해야 하는 값**으로 읽는다.
 *
 * 한국어로 남는 것이 어색해 보이지만 그것이 정직한 상태다: 이 자리는 사람이 지우고
 * 자기 주소를 넣는 칸이라, 무슨 언어든 꺾쇠가 그 뜻을 진다.
 */
export const SERVER_URL_PLACEHOLDER = '<서버 주소>';

/** PAT 자리표시. 토큰은 발급 순간에만 보이므로 상시 화면에는 이것만 실린다. 위와 같은 규율이다. */
export const PAT_PLACEHOLDER = '<발급한 토큰>';

/**
 * 손으로 띄우는 명령 한 벌을 만든다.
 *
 * `pat` 는 **자리표시든 실값이든 그대로** 넣는다 — `#125` 가 못박은 성질이다: 화면에 보이는
 * 명령과 클립보드에 들어가는 명령이 **글자 하나까지 같아야** 한다. 자르거나 말줄임표를
 * 붙이면 "완성된 명령"처럼 보이는데 붙여넣으면 인증이 실패한다.
 *
 * 그래서 화면과 복사 버튼이 **둘 다 이 함수를 부른다.** 두 자리가 각자 문자열을 만들던
 * 앞 판본이 정확히 이 파일이 없애는 갈라짐이었다.
 */
export function runnerCommands(pat: string): {
  /** 배포판(`.app` 사이드카) — 저장소가 없는 사람의 길이다. */
  bundled: string;
  /** 저장소를 클론한 개발 환경 전용. */
  dev: string;
} {
  const env = `MURMUR_URL=${SERVER_URL_PLACEHOLDER} MURMUR_PAT=${pat}`;
  return {
    bundled: `${env} ${RUNNER_SIDECAR_PATH}`,
    dev: `${env} ${RUNNER_DEV_COMMAND}`,
  };
}

/**
 * 복사 버튼이 클립보드에 넣는 값. 두 갈래를 한 벌로 넘긴다 — 사람은 자기 상황을 고른다.
 *
 * ## 번역기를 **필수 인자로 맨 뒤에** 받는다
 *
 * 이 파일은 화면이 아니라 훅을 못 쓴다(`i18n/index.ts::Translate` 의 (b) 주입).
 * **기본값을 두지 않는다** — 주면 부르는 화면이 조용히 한 언어로 굳고, 앞에 끼우면
 * 회귀선들이 자리만 어긋난 채 초록으로 틀린 것을 잰다.
 *
 * 두 주석 줄만 사전을 지난다. **명령 자체는 안 지난다** — 셸에 그대로 들어가는 값이라
 * 언어를 타면 붙여넣는 순간 실패한다(이 파일 머리말이 없애는 그 상태다).
 */
export function runnerCommandClipboardText(pat: string, t: Translate): string {
  const { bundled, dev } = runnerCommands(pat);
  return [
    t('agents.runner.commandBundledNote'),
    bundled,
    '',
    t('agents.runner.commandDevNote'),
    dev,
  ].join('\n');
}
