/**
 * 「내가 쓴 것은 따라 내려간다」의 **"내가"** 를 좁힌다 (2026-10-06, #1191 후속 d3).
 *
 * 채널·스레드 패널은 목록 끝에 **내 계정 이름으로** 새 줄이 붙으면 위를 읽고 있어도 바닥으로
 * 따라갔다. 작성칸에서 방금 보낸 사람의 관심은 그 글에 있으니 맞는 규칙인데, 같은 이름으로
 * 글을 쓰는 것이 작성칸만이 아니다 — 자동화는 승인한 사람 이름으로 나가고, 다른 기기에서
 * 보낸 것도 소켓으로 같은 작성자로 도착한다. 그때 위를 읽던 사람이 끌려 내려간다(designer n3).
 *
 * 그래서 따라갈 것은 **이 기기의 작성칸에서 보낸 글**뿐이다. 그 사실을 아는 자리는 컨트롤러의
 * `send`·`reply` 하나라서 거기서 두 가지를 적는다:
 *  - `sendsInFlight[자리]` — 보내는 중인 수. 소켓의 `message.created` 가 `postMessage` 응답보다
 *    **먼저** 올 수 있어, 그 줄의 id 를 아직 모를 때도 "지금 이 자리에서 보내는 중"이면 내 것으로
 *    본다(그 짧은 창에 자동화가 내 이름으로 끼어드는 것은 받아들인다).
 *  - `ownSendIds[id]` — 응답이 준 id. 응답을 스토어에 넣기 **전에** 적어야 같은 커밋에서 패널이 본다.
 *
 * 자리 열쇠는 채널 최상위면 채널 id, 답글이면 스레드 뿌리 id 다 — 두 패널이 서로의 보냄을
 * 자기 것으로 읽지 않게.
 */
import type { MessageRow } from '@harkroom/shared';

export interface OwnSendMarks {
  ownSendIds: Record<string, true>;
  sendsInFlight: Record<string, number>;
}

/** 적어 두는 id 의 상한 — 넘치면 오래된 것부터 버린다(한 세션에 수천 번 보내도 자라지 않게). */
export const OWN_SEND_IDS_CAP = 500;

/**
 * 목록 끝에 새로 붙은 줄 `last` 를 따라 내려갈지. `prevLastId` 는 직전 커밋의 마지막 줄 id(앞붙임과
 * 가르기 — #1191). 작성자가 나여도 이 기기에서 보낸 것이 아니면 거짓이다.
 */
export function appendedFromHere(
  last: MessageRow | undefined,
  prevLastId: string | null,
  meId: string | undefined,
  scopeKey: string,
  marks: OwnSendMarks,
): boolean {
  if (last === undefined || last.id === prevLastId || last.authorId !== meId) return false;
  return marks.ownSendIds[last.id] === true || (marks.sendsInFlight[scopeKey] ?? 0) > 0;
}

export function beginSend(marks: OwnSendMarks, scopeKey: string): OwnSendMarks {
  return { ...marks, sendsInFlight: { ...marks.sendsInFlight, [scopeKey]: (marks.sendsInFlight[scopeKey] ?? 0) + 1 } };
}

export function endSend(marks: OwnSendMarks, scopeKey: string): OwnSendMarks {
  const n = (marks.sendsInFlight[scopeKey] ?? 0) - 1;
  const rest = { ...marks.sendsInFlight };
  if (n > 0) rest[scopeKey] = n; else delete rest[scopeKey];
  return { ...marks, sendsInFlight: rest };
}

export function markOwnSend(marks: OwnSendMarks, id: string): OwnSendMarks {
  const ids = Object.keys(marks.ownSendIds);
  const next: Record<string, true> = {};
  for (const k of ids.slice(Math.max(0, ids.length + 1 - OWN_SEND_IDS_CAP))) next[k] = true;
  next[id] = true;
  return { ...marks, ownSendIds: next };
}
