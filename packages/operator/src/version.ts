/**
 * 이 오퍼레이터의 빌드 버전 — `hello.version` 으로 서버에 알린다.
 *
 * 화면의 러너 뒤처짐 판정이 이 값을 기준으로 삼는다(`desktop/src/lib/runnerVersions.ts`). 기준이
 * 보는 사람의 데스크탑 버전이면 어느 앱에서 보느냐에 따라 같은 러너가 최신도 되고 뒤처짐도 된다 —
 * 러너를 띄우는 것은 오퍼레이터이므로 "재기동하면 무엇이 되나"의 답도 오퍼레이터의 버전이다.
 *
 * ## 우선순위 (러너의 `agent/src/version.ts` 와 같은 모양)
 *
 * 1. `appVersion` — 앱이 `--app-version` 으로, 헤드리스가 `HARKROOM_OPERATOR_VERSION` 으로 준 값.
 *    러너에 `AGENT_VERSION` 으로 심는 값이 이것이므로(`assignments.ts`) 기준도 이것이어야 한다.
 * 2. 번들에 구운 값(`__OPERATOR_VERSION__`, `desktop/scripts/build-sidecars.mjs`). env 없이 도는
 *    헤드리스 오퍼레이터는 러너에 버전을 심지 않고, 그 러너는 **같은 번들에 구운** 자기 버전을
 *    보고한다 — 그러니 기준도 같은 번들의 구운 값이다.
 * 3. `null` — 둘 다 없다(소스에서 도는 개발 경로). hello 에 싣지 않고, 화면은 "모른다"로 둔다.
 *    거짓 버전을 보내지 않는다(docs/design.md 4절).
 */

/** esbuild `define` 이 치환한다. 치환되지 않은 환경에서는 선언되지 않은 식별자다 — `typeof` 로만 만진다. */
declare const __OPERATOR_VERSION__: string | undefined;

const baked = typeof __OPERATOR_VERSION__ === 'string' && __OPERATOR_VERSION__ !== ''
  ? __OPERATOR_VERSION__
  : null;

export function operatorVersion(appVersion: string | null | undefined, bakedVersion: string | null = baked): string | null {
  if (appVersion) return appVersion;
  return bakedVersion;
}
