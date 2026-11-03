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

// runner: 러너 알림 줄(앞 턴 대기·임대 잃음·조종 대기, 2026-11-02) — 누구의 요청에 대한 응답이 아니라 사람 멘션의 상태다.
// plan: 계획판 「이제 시작 가능」 줄(P6) — 누구의 요청에 대한 응답이 아니라 계획 상태의 기록이다.
const RECORD_KEY = /^system\.(member|threadModel|runner|plan)\./;

export function systemLineShape(message: Pick<MessageRow, 'kind' | 'meta'>): SystemLineShape | null {
  if (message.kind !== 'system') return null;
  const meta = (message.meta ?? {}) as Record<string, unknown>;
  if (meta.chatApproval !== undefined || meta.blocked !== undefined || meta.secretNotice !== undefined
    || typeof meta.skillSlug === 'string') return 'response';
  const parsed = parseSystemI18n(meta.i18n);
  if (!parsed) return 'record';
  return RECORD_KEY.test(parsed.key) ? 'record' : 'response';
}

/** 기록 줄의 아이콘(시안 C) — 들어옴 ＋ · 나감/내보냄 − · 모델 ⚙ · 대기(앞 턴·조종) ⏳ · 넘겨받음 ↪ · 그 밖(옛 줄) •. */
export function systemRecordIcon(message: Pick<MessageRow, 'meta'>): string {
  const key = parseSystemI18n((message.meta as Record<string, unknown> | undefined)?.i18n)?.key ?? '';
  if (key.startsWith('system.member.added')) return '＋';
  if (key.startsWith('system.member.')) return '−';
  if (key.startsWith('system.threadModel.')) return '⚙';
  if (key === 'system.runner.fenced') return '↪';
  if (key.startsWith('system.plan.')) return '▶';
  if (key.startsWith('system.runner.')) return '⏳';
  return '•';
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

/**
 * 계획판 ready 줄의 단계 이름(P6) — `meta.planReady.ids` 순서대로, 제목이 있으면 제목(`meta.planReady.titles`), 없으면 id.
 * 서버가 본문에서 뺀 남의 글이라 화면은 이것을 **글자로만** 그린다. id 꼴만 받고(최대 40개), 제목은 120자로 자른다.
 * 제목이 하나도 없으면 빈 목록 — 그때는 서버가 준 문장(id 목록)을 그대로 쓴다.
 */
export function planReadyTitles(message: Pick<MessageRow, 'kind' | 'meta'>): { id: string; label: string }[] {
  if (message.kind !== 'system') return [];
  const ready = (message.meta as Record<string, unknown> | undefined)?.planReady as { ids?: unknown; titles?: unknown } | undefined;
  if (!ready || !Array.isArray(ready.ids)) return [];
  const titles = ready.titles && typeof ready.titles === 'object' ? ready.titles as Record<string, unknown> : {};
  let anyTitle = false;
  const out: { id: string; label: string }[] = [];
  for (const id of ready.ids.slice(0, 40)) {
    if (typeof id !== 'string' || !/^[sg][1-9][0-9]{0,3}$/.test(id)) continue;
    const t = Object.prototype.hasOwnProperty.call(titles, id) ? titles[id] : undefined;
    if (typeof t === 'string' && t.trim()) {
      anyTitle = true;
      out.push({ id, label: [...t.trim()].slice(0, 120).join('') });
    } else {
      out.push({ id, label: id });
    }
  }
  return anyTitle ? out : [];
}
