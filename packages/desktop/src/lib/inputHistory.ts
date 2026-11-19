import type { MessageRow } from '@harkroom/shared';

/**
 * 입력창 ↑·↓ 로 **내가 보낸 글을 다시 불러오기**(셸 history 처럼).
 *
 * 기록의 출처는 따로 쌓지 않고 **이 채널에 이미 받아 둔 메시지 중 내 글**이다:
 * - 다른 기기에서 보낸 글도 들어오고, 지운 글·고친 글은 서버의 지금 모습으로 들어온다.
 * - 디스크에 새로 남기는 것이 없다 — 로그아웃 때 따로 지울 것이 생기지 않는다(초안 보관과 같은 기준).
 * - 스레드 답글도 같은 채널 목록에 있으므로 채널 입력창과 스레드 입력창이 같은 기록을 본다(범위 = 채널).
 *
 * 본문은 저장형(`<@id>`)이라 사람이 읽고 고치는 꼴(`@handle`)로 바꾸는 함수를 받는다 — 글 고치기가 쓰는 것과 같은 것.
 */
export function sentHistory(
  rows: readonly MessageRow[] | undefined,
  myId: string | undefined,
  toText: (body: string) => string,
  limit = HISTORY_LIMIT,
): string[] {
  if (!rows || !myId) return [];
  const mine = rows
    .filter((m) => m.authorId === myId && m.kind === 'user' && !m.deletedAt && m.body.trim() !== '')
    .sort((a, b) => b.seq - a.seq);
  const out: string[] = [];
  for (const m of mine) {
    const text = toText(m.body);
    // 같은 글을 잇달아 보냈으면 한 번만 — ↑ 를 눌렀는데 아무것도 안 바뀌면 고장 난 줄로 안다.
    if (out[out.length - 1] === text) continue;
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

export const HISTORY_LIMIT = 100;

/**
 * 기록을 걷는 중의 상태. `index` 는 기록에서 몇 번째 글을 보이는지(0 = 가장 최근), `saved` 는
 * 걷기 시작할 때 쓰던 초안, `shown` 은 지금 입력창에 넣어 둔 글이다.
 *
 * 입력창 글이 `shown` 과 달라졌으면(사람이 고쳤다) 걷기는 끝난 것이다 — 고친 글이 새 초안이 된다.
 * 자리(`scope`)가 바뀌어도 끝난 것이다.
 */
export interface HistoryWalk {
  scope: string;
  index: number;
  saved: string;
  shown: string;
}

export type HistoryStep =
  /** 이 글을 입력창에 넣는다. */
  | { kind: 'show'; text: string; walk: HistoryWalk | null }
  /** 열쇠는 먹되 바꿀 것이 없다(가장 오래된 글에서 ↑). */
  | { kind: 'stay' }
  /** 기록 걷기와 상관없는 열쇠다 — 편집기의 평소 동작(커서 이동)에 맡긴다. */
  | { kind: 'pass' };

/**
 * ↑(`older`)·↓(`newer`) 한 번. 순수 함수 — 커서 자리·조합 중 판정은 부르는 쪽이 먼저 한다.
 */
export function stepHistory(
  walk: HistoryWalk | null,
  dir: 'older' | 'newer',
  scope: string,
  value: string,
  entries: readonly string[],
): HistoryStep {
  const live = walk && walk.scope === scope && walk.shown === value ? walk : null;
  if (dir === 'older') {
    const index = live ? live.index + 1 : 0;
    if (index >= entries.length) return live ? { kind: 'stay' } : { kind: 'pass' };
    const text = entries[index]!;
    return { kind: 'show', text, walk: { scope, index, saved: live ? live.saved : value, shown: text } };
  }
  // ↓ 는 걷는 중일 때만 뜻이 있다 — 아니면 평소의 커서 이동이다.
  if (!live) return { kind: 'pass' };
  if (live.index === 0) return { kind: 'show', text: live.saved, walk: null };
  const index = live.index - 1;
  const text = entries[index] ?? live.saved;
  return { kind: 'show', text, walk: { ...live, index, shown: text } };
}
