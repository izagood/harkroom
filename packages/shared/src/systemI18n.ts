/**
 * 서버가 만드는 **시스템 줄의 번역 표지**(i18n P5 ①, jaebin 결정 D1-B, 2026-10-10).
 *
 * 시스템 줄(멤버 들고남·스레드 모델·머지 결과·API 호출·막힘 카드·권한 위임·비밀 알림·스킬 제안)은
 * 본문을 한국어로 저장한다(D2·D3 — 옛 앱·검색·푸시·에이전트가 계속 본문을 읽는다). 그 옆에
 * `meta.i18n = { key, args }` 를 함께 실어, 새 앱은 **앱 언어의 사전**에서 문장을 찾아 그린다.
 * 키를 모르는 앱(옛 앱)·표지가 없는 줄(옛 줄)은 본문으로 물러난다.
 *
 * ## 이 파일이 지키는 것 (security C1·C3·C4)
 *
 * - **키는 이 목록에 있는 것만**이다(C3). 서버는 쓸 때, 앱은 그릴 때 `parseSystemI18n` 을 지난다.
 *   조회는 `Object.hasOwn` 이다 — `key in obj` 나 `obj[key]` 는 `constructor`·`__proto__` 를 통과시킨다.
 * - **인자는 원시값만**, 개수·길이 상한이 있다(C4). 상한을 넘거나 모양이 틀리면 표지 전체를 버린다
 *   (`null`) — 반쯤 그리지 않고 본문으로 물러난다.
 * - 이 표지는 **서버가 만든 `kind: 'system'` 줄에만** 붙는다(C1). 사람·에이전트 글에 실려 오면 서버가
 *   지운다(`postMessage`), 앱도 `kind === 'system'` 일 때만 본다(C2, 앱 쪽 PR).
 *
 * ## 인자 이름 규약
 *
 * `...Id` 로 끝나는 인자는 **계정 id** 다. 앱이 지금 이름(handle)으로 바꿔 그리고, 모르면 「알 수 없음」 을
 * 쓴다(designer 규칙 1) — 이름을 바꾸면 지난 줄도 새 이름으로 그려진다(#329 의 `meta.accountId` 와 같은 뜻).
 * 그 밖의 인자는 그대로 끼운다(React 텍스트로만, 마크다운·링크 렌더 없음).
 */

/**
 * 키 목록. **값은 쓰지 않는다** — 문장은 앱 사전(`desktop/src/i18n`·`mobile/lib/i18n`)이 가진다.
 * 레코드로 두는 이유는 `Object.hasOwn` 으로 조회하려는 것이고, 키마다 받는 인자를 적어 둔다
 * (서버 빌더·앱 사전·시험이 같은 표를 본다).
 */
export const SYSTEM_I18N_ARGS = Object.freeze({
  'system.member.added': ['accountId'],
  'system.member.left': ['accountId'],
  'system.member.removed': ['accountId'],
  'system.threadModel.set': ['accountId', 'agentId', 'value'],
  'system.threadModel.setByAgent': ['accountId', 'agentId', 'value'],
  'system.threadModel.cleared': ['accountId', 'agentId'],
  'system.threadModel.clearedByAgent': ['accountId', 'agentId'],
  'system.merge.approvalUsed': ['repo', 'number', 'head', 'ghUser'],
  'system.merge.approvalUsedRelaxed': ['repo', 'number', 'head', 'ghUser'],
  'system.merge.merged': ['repo', 'number', 'sha'],
  'system.merge.mergedGranted': ['repo', 'number', 'sha', 'granterId'],
  'system.merge.failed': ['repo', 'number', 'head'],
  'system.apiCall.done': ['connector', 'method', 'path', 'status'],
  'system.apiCall.doneGranted': ['connector', 'method', 'path', 'status', 'granterId'],
  'system.apiCall.unreachable': ['connector', 'method', 'path'],
  'system.apiCall.unreachableGranted': ['connector', 'method', 'path', 'granterId'],
  'system.apiBlocked': ['agentId', 'connector', 'request', 'code'],
  'system.apiBlocked.noConnector': ['agentId', 'request', 'code'],
  'system.delegation.pending': ['fromId', 'toId', 'scope', 'rootId'],
  'system.delegation.done': ['fromId', 'toId', 'scope', 'rootId'],
  'system.secret.createdGenerated': ['agentId', 'name', 'type', 'ownerId'],
  'system.secret.createdImported': ['agentId', 'name', 'ownerId'],
  'system.secret.rotatedGenerated': ['agentId', 'name', 'version', 'type', 'ownerId'],
  'system.secret.rotatedImported': ['agentId', 'name', 'version', 'ownerId'],
  'system.skill.proposed': ['slug'],
  'system.skill.proposedFlagged': ['slug', 'reason'],
} as const satisfies Record<string, readonly string[]>);

export type SystemI18nKey = keyof typeof SYSTEM_I18N_ARGS;
export type SystemI18nArgs = Record<string, string | number>;
/**
 * 키마다 받는 인자를 **타입으로** 매긴다(security n1-a). 서버 빌더가 이것을 받으므로 인자 이름을 틀리거나
 * 빠뜨리면 tsc 가 막는다 — 실행 중에 던지는 자리가 머지·호출 기록을 남기는 곳이라, 거기서 터지면
 * 기록이 통째로 빠진다.
 */
export type SystemI18nArgsOf<K extends SystemI18nKey> = Record<(typeof SYSTEM_I18N_ARGS)[K][number], string | number>;
export interface SystemI18n { key: SystemI18nKey; args: SystemI18nArgs }

/** 인자 개수 상한. 가장 많이 받는 키가 5개다 — 여유를 두되 끝없이 받지 않는다. */
export const SYSTEM_I18N_MAX_ARGS = 8;
/** 문자열 인자 길이 상한. 경로·저장소 이름·스코프 글이 가장 길다. */
export const SYSTEM_I18N_MAX_ARG_LENGTH = 200;

export function isSystemI18nKey(key: unknown): key is SystemI18nKey {
  return typeof key === 'string' && Object.hasOwn(SYSTEM_I18N_ARGS, key);
}

/**
 * `meta.i18n` 을 믿을 수 있는 모양으로 읽는다. 하나라도 어긋나면 `null` — 그때 화면은 본문을 그린다.
 *
 * - 키가 목록에 있다
 * - `args` 는 평범한 객체이고 그 키가 받는 인자 이름만, 빠짐없이 있다
 * - 값은 문자열(길이 상한) 또는 유한한 수
 */
export function parseSystemI18n(value: unknown): SystemI18n | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { key, args } = value as { key?: unknown; args?: unknown };
  if (!isSystemI18nKey(key)) return null;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  const names = Object.keys(args);
  const expected: readonly string[] = SYSTEM_I18N_ARGS[key];
  if (names.length > SYSTEM_I18N_MAX_ARGS || names.length !== expected.length) return null;
  const out: SystemI18nArgs = {};
  for (const name of expected) {
    if (!Object.hasOwn(args, name)) return null;
    const v = (args as Record<string, unknown>)[name];
    if (typeof v === 'string') {
      if (v.length > SYSTEM_I18N_MAX_ARG_LENGTH) return null;
      out[name] = v;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      out[name] = v;
    } else {
      return null;
    }
  }
  return { key, args: out };
}
