import { parseSystemI18n, type MessageRow } from '@harkroom/shared';
import { messageLinkFromMeta } from './link';

/**
 * 시스템 줄의 두 겹(시스템 줄 C안, designer 시안 2026-10-24 · jaebin 선택).
 *
 * 시스템 줄(`kind: 'system'`)의 `authorId` 는 그 줄을 **일으킨** 계정(글 승인을 쓴 사람·채널에 넣은 admin·
 * 알림 대상 에이전트)일 뿐 말한 사람이 아니다. 그래서 화면은 시스템 줄을 누구의 발화로도 그리지 않는다:
 *
 * - `record` — 기록 줄(멤버 들고남·스레드 모델·표지 없는 옛 줄). 아이콘 + 작은 한 줄, 이름줄 없음.
 * - `response` — 누군가의 글·행동에 **응답하는** 줄(채팅 승인 결과, 에이전트가 일으킨 막힘·비밀·스킬·
 *   API·머지 카드). 「Harkroom · 시스템」 작성자 + 「↳ 누구의 무엇에 대해」 칩. 그 사람은 **대상**으로만 나온다.
 *
 * 저장 모양은 바꾸지 않았으므로(저장 방식 A) 옛 데이터도 이 판정으로 같이 고쳐진다.
 */
export type SystemLineShape = 'record' | 'response';

const RECORD_KEY = /^system\.(member|threadModel)\./;

export function systemLineShape(message: Pick<MessageRow, 'kind' | 'meta'>): SystemLineShape | null {
  if (message.kind !== 'system') return null;
  const meta = (message.meta ?? {}) as Record<string, unknown>;
  if (meta.chatApproval !== undefined || meta.blocked !== undefined || meta.secretNotice !== undefined
    || typeof meta.skillSlug === 'string') return 'response';
  const parsed = parseSystemI18n(meta.i18n);
  if (!parsed) return 'record';
  return RECORD_KEY.test(parsed.key) ? 'record' : 'response';
}

/**
 * 응답 줄 칩의 재료 — 누구의(`accountId`) 무엇에(`what`) 대한 응답인가. 채팅 승인 결과는 그 글로 가는
 * 링크를 함께 준다(`meta.chatApproval.messageId`). 그 밖의 카드는 author(카드를 일으킨 에이전트)의 요청이다.
 */
export function systemLineTarget(message: Pick<MessageRow, 'authorId' | 'meta'>): {
  accountId: string; what: 'post' | 'request'; href: string | null;
} {
  const chat = (message.meta as Record<string, unknown> | undefined)?.chatApproval as { messageId?: unknown } | undefined;
  if (chat) return { accountId: message.authorId, what: 'post', href: messageLinkFromMeta(chat.messageId) };
  return { accountId: message.authorId, what: 'request', href: null };
}
