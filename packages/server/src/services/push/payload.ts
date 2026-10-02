// 푸시 페이로드를 만드는 순수 함수. 무엇이 Apple 을 지나 잠금 화면에 뜨는지가 **이 파일 하나**로
// 정해진다. 시험(pushPayload)이 결과 전체를 고정한다.
//
// - 미리보기가 꺼져 있으면(기본, 결정 3) 본문이나 그 일부를 **어디에도** 싣지 않는다. `hk` 도
//   마찬가지다. 사유는 `loc-key` 로만 보내고, 문구는 앱이 자기 언어로 그린다(서버는 기기의
//   언어를 모른다).
// - 켜져 있으면 그 시점의 본문(수정 반영)을 멘션을 이름으로 바꾼 뒤 120자로 자른다. 비밀 가림은
//   부르는 쪽(worker)이 먼저 거른다.
// - `hk` 에는 화면을 열 id 만 싣는다. 계정 id 는 커뮤니티를 고르는 열쇠다(앱의 열쇠
//   `origin#accountId` 가운데 계정 id 만으로도 가를 수 있고, 무작위 UUID 라 서버끼리 겹치지 않는다).
//   origin 은 싣지 않는다. 서버는 자기 공개 주소를 모르고, 앱이 그것을 요청 주소로 쓸 일도 없다.
import { renderMentions } from '@harkroom/shared';

export type PushReason = 'mention' | 'thread_reply' | 'dm' | 'ask';

export const PUSH_PREVIEW_MAX = 120;

export interface PushPayloadInput {
  reason: PushReason;
  accountId: string;
  messageId: string;
  channelId: string;
  threadRootId: string | null;
  authorHandle: string | null;
  /** 채널이면 이름, DM 이면 null. */
  channelName: string | null;
  /** null 이면 싣지 않는다(기기가 배지를 끔 — 앱이 여러 커뮤니티의 합을 직접 적는다). */
  badge: number | null;
  /** null 이면 미리보기를 싣지 않는다. 있으면 이미 가림을 거친 저장 본문(`<@id>` 형식)이다. */
  previewBody: string | null;
  idToHandle: Map<string, string>;
}

export const PUSH_LOC_KEYS: Record<PushReason, string> = {
  mention: 'PUSH_REASON_MENTION',
  thread_reply: 'PUSH_REASON_THREAD_REPLY',
  dm: 'PUSH_REASON_DM',
  ask: 'PUSH_REASON_ASK',
};

export function pushTitle(authorHandle: string | null, channelName: string | null): string {
  const who = authorHandle ? `@${authorHandle}` : 'Harkroom';
  return channelName ? `${who} · #${channelName}` : who;
}

export function previewText(body: string, idToHandle: Map<string, string>): string {
  const flat = renderMentions(body, idToHandle).replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > PUSH_PREVIEW_MAX ? `${chars.slice(0, PUSH_PREVIEW_MAX - 1).join('')}…` : flat;
}

export function buildPushPayload(input: PushPayloadInput): Record<string, unknown> {
  const title = pushTitle(input.authorHandle, input.channelName);
  const preview = input.previewBody !== null ? previewText(input.previewBody, input.idToHandle) : '';
  const alert = preview
    ? { title, body: preview }
    : { title, 'loc-key': PUSH_LOC_KEYS[input.reason] };
  return {
    aps: { alert, ...(input.badge !== null ? { badge: input.badge } : {}), sound: 'default', 'thread-id': input.channelId },
    hk: {
      v: 1,
      accountId: input.accountId,
      messageId: input.messageId,
      channelId: input.channelId,
      threadRootId: input.threadRootId,
    },
  };
}
