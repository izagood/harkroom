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

/**
 * 알림의 **종류**(designer 개선안 harkroom://message/5afd59e0-9e38-4273-8e9a-2aebcc426d55 의 규칙 표).
 * 사유(reason)는 "왜 inbox 에 들어왔나"이고, 종류는 "폰에서 어떻게 보일까"다. 에이전트는 답할 때
 * 요청자를 부르므로 사유만 보면 모든 답이 `mention` 이 된다 — 그래서 글의 `meta.kind`·쓴 이·스레드를
 * 함께 보고 worker 가 정한다(`classifyPush`).
 */
export type PushKind =
  | 'ask' | 'fail' | 'gate' | 'done' | 'agent_reply'
  | 'mention' | 'thread_reply' | 'dm';

export const PUSH_PREVIEW_MAX = 120;

/** 같은 스레드의 에이전트 보통 답은 이 간격 안에 한 번만 울린다(jaebin D1). */
export const PUSH_REPLY_SOUND_WINDOW_MS = 10 * 60_000;

export interface PushClassifyInput {
  reason: PushReason;
  authorKind: 'human' | 'agent';
  /** 글의 `meta.kind`(ask·failure·report …). 없으면 null. */
  metaKind: string | null;
  /** `meta.failure.code`. */
  failureCode: string | null;
  /** 받는 사람이 연(루트를 쓴) 스레드이거나 그 안에서 말한 적이 있는가. */
  mineThread: boolean;
}

export function classifyPush(i: PushClassifyInput): PushKind {
  if (i.reason === 'ask' || i.metaKind === 'ask') return 'ask';
  if (i.metaKind === 'failure') return i.failureCode === 'account_gate' ? 'gate' : 'fail';
  if (i.reason === 'dm') return 'dm';
  if (i.authorKind === 'agent') {
    if (i.metaKind === 'report') return 'done';
    if (i.mineThread) return 'agent_reply';
  }
  return i.reason === 'mention' ? 'mention' : 'thread_reply';
}

/** 손댈 일이라 집중 모드도 뚫는 종류. 알림마다 따로 남긴다(교체하지 않는다). */
const URGENT: ReadonlySet<PushKind> = new Set(['ask', 'fail', 'gate']);

export const isUrgentPush = (k: PushKind): boolean => URGENT.has(k);

/** 미리보기가 꺼졌을 때(또는 가림에 걸렸을 때) 본문 대신 쓰는 사유 문구 키. 앱의 Localizable.strings 에 있다. */
export const PUSH_LOC_KEYS: Record<PushKind, string> = {
  mention: 'PUSH_REASON_MENTION',
  thread_reply: 'PUSH_REASON_THREAD_REPLY',
  dm: 'PUSH_REASON_DM',
  ask: 'PUSH_REASON_ASK',
  fail: 'PUSH_REASON_FAIL',
  gate: 'PUSH_REASON_GATE',
  done: 'PUSH_REASON_DONE',
  agent_reply: 'PUSH_REASON_REPLIES',
};

/** 부제 `[종류] @보낸 이`. 이름은 loc-args 로 넘겨 앱이 자기 언어 틀에 끼운다. DM 은 제목이 상대라 부제가 없다. */
export const PUSH_SUBTITLE_KEYS: Record<Exclude<PushKind, 'dm'>, string> = {
  mention: 'PUSH_SUB_MENTION',
  thread_reply: 'PUSH_SUB_THREAD_REPLY',
  ask: 'PUSH_SUB_ASK',
  fail: 'PUSH_SUB_FAIL',
  gate: 'PUSH_SUB_GATE',
  done: 'PUSH_SUB_DONE',
  agent_reply: 'PUSH_SUB_REPLIES',
};

export interface PushPayloadInput {
  kind: PushKind;
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
  /** `agent_reply` 의 "답 N" — 그 스레드의 안 읽은 답 수. 다른 종류는 무시한다. */
  replyCount: number;
  /** `ask` 의 선택지 수(0 이면 문구에서 뺀다). */
  optionCount: number;
  /** 이번에 소리를 낼까. 급한 종류는 늘 true 로 넘어온다. false 면 passive(조용히 쌓임). */
  sound: boolean;
}

/**
 * 제목은 **어디서**(`#채널`, DM 이면 `@상대`). 누가·무슨 종류인지는 부제로 간다.
 * 스레드 제목(루트 본문 첫 줄)은 싣지 않는다 — 본문의 일부라서 미리보기를 끈 사람(결정 3)의 글이
 * Apple 을 지나게 된다. 그것은 P2(알림 서비스 확장)가 폰에서 채운다.
 */
export function pushTitle(authorHandle: string | null, channelName: string | null): string {
  if (channelName) return `#${channelName}`;
  return authorHandle ? `@${authorHandle}` : 'Harkroom';
}

/** APNs 묶음(`thread-id`) — 알림 센터에서 한 더미가 되는 단위. 스레드마다, DM 은 대화마다. */
export function pushThreadKey(input: Pick<PushPayloadInput, 'channelId' | 'channelName' | 'threadRootId' | 'messageId'>): string {
  if (input.channelName === null) return input.channelId;
  return input.threadRootId ?? input.messageId;
}

/**
 * APNs 교체 키(`apns-collapse-id`, 64바이트 이하). 같은 키의 새 알림은 새 줄이 아니라 그 줄을 바꾼다.
 * 에이전트의 보통 답·완료는 스레드마다 한 장을 갈아쓰고, 손댈 일(결정·실패)과 사람의 말은 글마다 남긴다.
 */
export function pushCollapseId(kind: PushKind, threadKey: string, messageId: string): string {
  if (kind === 'agent_reply' || kind === 'done') return `reply:${threadKey}`;
  if (kind === 'ask' || kind === 'fail' || kind === 'gate') return `${kind}:${messageId}`;
  return messageId;
}

export function previewText(body: string, idToHandle: Map<string, string>): string {
  const flat = renderMentions(body, idToHandle).replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > PUSH_PREVIEW_MAX ? `${chars.slice(0, PUSH_PREVIEW_MAX - 1).join('')}…` : flat;
}

function subtitle(input: PushPayloadInput): Record<string, unknown> {
  if (input.kind === 'dm') return {};
  const who = input.authorHandle ?? 'Harkroom';
  const key = PUSH_SUBTITLE_KEYS[input.kind];
  // "답 N · @이름" 만 숫자를 앞에 하나 더 받는다.
  const args = input.kind === 'agent_reply' ? [String(Math.max(1, input.replyCount)), who] : [who];
  return { 'subtitle-loc-key': key, 'subtitle-loc-args': args };
}

function fallbackBody(input: PushPayloadInput): Record<string, unknown> {
  const key = PUSH_LOC_KEYS[input.kind];
  if (input.kind === 'agent_reply') return { 'loc-key': key, 'loc-args': [String(Math.max(1, input.replyCount))] };
  if (input.kind === 'ask' && input.optionCount > 0) return { 'loc-key': 'PUSH_REASON_ASK_OPTIONS', 'loc-args': [String(input.optionCount)] };
  return { 'loc-key': key };
}

export function buildPushPayload(input: PushPayloadInput): Record<string, unknown> {
  const title = pushTitle(input.authorHandle, input.channelName);
  const preview = input.previewBody !== null ? previewText(input.previewBody, input.idToHandle) : '';
  const alert = { title, ...subtitle(input), ...(preview ? { body: preview } : fallbackBody(input)) };
  const urgent = isUrgentPush(input.kind);
  const level = urgent ? 'time-sensitive' : input.sound ? 'active' : 'passive';
  return {
    aps: {
      alert,
      ...(input.badge !== null ? { badge: input.badge } : {}),
      ...(urgent || input.sound ? { sound: 'default' } : {}),
      'interruption-level': level,
      'thread-id': pushThreadKey(input),
    },
    hk: {
      v: 1,
      accountId: input.accountId,
      messageId: input.messageId,
      channelId: input.channelId,
      threadRootId: input.threadRootId,
    },
  };
}
