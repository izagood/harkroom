import { UNKNOWN_ACCOUNT_LABEL, parseSystemI18n, type MessageRow } from '@harkroom/shared';
import { en } from '../i18n/en';
import { detectLocale, isLocale, translator, type MessageKey, type Translate } from '../i18n';
import { usePrefsStore } from '../state/prefsStore';

/**
 * 시스템 줄을 **앱 언어로** 적는다(i18n P5 ②, jaebin 결정 D1-B).
 *
 * 서버는 시스템 줄에 한국어 본문과 함께 `meta.i18n = { key, args }` 를 싣는다(`shared/src/systemI18n.ts`).
 * 이 함수는 그 표지를 사전 문장으로 바꾼다. 못 바꾸면 `null` — 부르는 쪽은 본문으로 물러난다(옛 줄·옛 서버).
 *
 * ## 지키는 것 (security C2·C3·C4, designer 규칙 1)
 *
 * - **C2** `kind === 'system'` 일 때만 본다. 사람·에이전트 글에 표지가 실려 와도 그리지 않는다(서버 C1 위의 한 겹).
 * - **C3** `parseSystemI18n` 을 지난다 — 목록 밖 키·모양이 틀린 인자면 `null`. 키 표의 키는 이 앱 사전의 키와
 *   같은 글자이고, 사전에 없으면(이 앱이 서버보다 옛것) 역시 `null` 이다(`Object.hasOwn`).
 * - **C4** `...Id` 인자는 계정 id 다 — 지금 이름(handle)으로 바꾸고, 모르면 「알 수 없음」(designer 규칙 1).
 *   문자열 인자는 제어 문자·방향 바꿈 문자(bidi)를 지운다. 결과는 **React 텍스트로만** 그린다 —
 *   마크다운·링크 렌더를 지나지 않는다(`MessageItem` 이 `MessageBody` 대신 글로 그린다).
 * - **security n2** 막힘 카드의 `code` 는 사전(`blocked.why.*`)에 있는 것만 옮기고, 모르는 것은 글자 그대로 둔다.
 */
export function systemText(
  message: Pick<MessageRow, 'kind' | 'meta'>,
  accounts: Record<string, { handle: string }>,
  t: Translate,
): string | null {
  if (message.kind !== 'system') return null;
  const parsed = parseSystemI18n((message.meta as Record<string, unknown> | undefined)?.i18n);
  if (!parsed || !Object.hasOwn(en, parsed.key)) return null;
  const args: Record<string, string | number> = {};
  for (const [name, v] of Object.entries(parsed.args)) {
    if (typeof v === 'number') { args[name] = v; continue; }
    if (name.endsWith('Id')) {
      const handle = Object.hasOwn(accounts, v) ? accounts[v]?.handle : undefined;
      args[name] = clean(handle ?? UNKNOWN_ACCOUNT_LABEL);
    } else {
      args[name] = clean(v);
    }
  }
  if (typeof args.code === 'string') {
    const why = `blocked.why.${args.code}`;
    if (Object.hasOwn(en, why)) args.code = t(why as MessageKey);
  }
  return t(parsed.key as MessageKey, args);
}

/** 제어 문자·방향 바꿈 문자를 지운다 — 인자로 줄을 꾸미거나 순서를 뒤집지 못하게(C4). 줄바꿈은 공백으로. */
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ');
}

/**
 * React 밖(`displayBody` — 미리보기·알림·검색 발췌)에서 지금 언어로 부른다. `useLocale` 과 같은 규약이다
 * (저장값이 모르는 언어면 브라우저에게 묻는다). #1305 의 `nowT()` 가 들어오면 그것으로 바꾼다.
 */
export function systemTextNow(
  message: Pick<MessageRow, 'kind' | 'meta'>, accounts: Record<string, { handle: string }>,
): string | null {
  const pref = usePrefsStore.getState().locale;
  return systemText(message, accounts, translator(isLocale(pref) ? pref : detectLocale()));
}
