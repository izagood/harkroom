import {
  SYSTEM_I18N_MAX_ARG_LENGTH, parseSystemI18n, type SystemI18n, type SystemI18nArgs, type SystemI18nKey,
} from '@harkroom/shared';

/**
 * 시스템 줄의 `meta.i18n` 을 만든다(i18n P5 ①). **본문을 만드는 바로 그 자리에서** 같은 값으로 부른다 —
 * 본문(푸시·검색·옛 앱·에이전트가 읽는다)과 표지(새 앱이 그린다)가 같은 일을 말해야 한다(security C8).
 *
 * 문자열 인자는 상한 길이로 자른다 — 경로·스코프처럼 바깥에서 온 값이 길면 표지 전체가 버려지는
 * 대신 잘린 값이 선다. 그 밖에 모양이 틀리면(목록 밖 키·빠진 인자) **던진다**: 서버 코드의 실수이고,
 * 조용히 넘기면 그 줄만 옛 본문으로 그려져 아무도 모른다. 시험이 이것으로 키 표와 빌더를 맞춘다.
 */
export function systemI18n(key: SystemI18nKey, args: SystemI18nArgs): SystemI18n {
  const clipped: SystemI18nArgs = {};
  for (const [name, v] of Object.entries(args)) {
    clipped[name] = typeof v === 'string' ? v.slice(0, SYSTEM_I18N_MAX_ARG_LENGTH) : v;
  }
  const parsed = parseSystemI18n({ key, args: clipped });
  if (!parsed) throw new Error(`systemI18n: ${key} 의 인자가 키 표(SYSTEM_I18N_ARGS)와 맞지 않는다`);
  return parsed;
}

/**
 * 사람·에이전트가 보낸 글의 `meta` 에서 `i18n` 을 뺀다(security C1). `meta.i18n` 은 앱이 **시스템 줄로
 * 그리는 근거**라, 열려 있으면 누구나 「머지됨」·「채널에 추가됨」 같은 가짜 시스템 줄을 세울 수 있다.
 * 시스템 줄(`kind: 'system'`)은 서버 코드만 만들므로 그것만 통과시키고, 그때도 모양을 다시 본다.
 */
export function guardMetaI18n(
  kind: string | undefined, meta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!meta || !Object.hasOwn(meta, 'i18n')) return meta;
  if (kind === 'system' && parseSystemI18n(meta.i18n)) return meta;
  const { i18n: _dropped, ...rest } = meta;
  return rest;
}
