import { useEffect, useState } from 'react';
import type { CollabProposal, CollabProposalsView, CollabRepoView } from '@harkroom/shared';
import { getController } from '../state/controller';

/**
 * 협업 탭이 볼 것을 서버에 물어 오는 자리(`GET /collab/proposals`, `docs/hub-seat.md` 0단계).
 *
 * ## 상태가 셋인 이유 — `agentTurns.ts` 와 같은 규율
 *
 * `known` 은 물어서 받은 답이고 `unknown` 은 **물었지만 답을 못 받은** 것이다. 둘을 같은
 * 모양으로 그리면 "제안 없음" 이 서고, 사람은 아무도 일하지 않는 줄 안다 — 그 칸이 하필
 * "내가 무엇을 막고 있나" 에 답하는 자리라 더 나쁘다. `checking` 은 첫 답 전이다.
 *
 * ## 폴러를 모듈에 두는 이유
 *
 * 이 훅을 부르는 곳이 둘이 되면(칸의 요약과 본문) 각자 타이머를 갖는 구조는 같은 요청을 두 번
 * 내고 두 화면이 서로 다른 순간을 보인다. `agentTurns.ts` 가 같은 이유로 이미 이 모양이다.
 *
 * 주기는 그보다 길다(20초). 저 목록은 "지금 도는 턴" 이라 26초짜리도 놓치면 안 되지만,
 * 제안은 사람이 승인하기 전까지 **머무는 것**이라 몇 초의 지연이 거짓을 만들지 않는다.
 * 이 요청은 저장소마다 avcs 를 한 번씩 두드리므로 주기를 짧게 잡는 값이 그쪽에서 든다.
 */
export type CollabSnapshot =
  /** 첫 답이 아직 안 왔다. 빈 목록과 **다르다.** */
  | { kind: 'checking' }
  | { kind: 'known'; view: CollabProposalsView }
  /** 물었지만 답을 못 받았다. 사유는 서버·전송이 쓴 문구를 그대로 옮긴다. */
  | { kind: 'unknown'; reason: string };

export const COLLAB_POLL_MS = 20_000;

const listeners = new Set<(snapshot: CollabSnapshot) => void>();
let shared: CollabSnapshot = { kind: 'checking' };
let timer: ReturnType<typeof setInterval> | null = null;

async function askOnce(): Promise<void> {
  try {
    // 컨트롤러에서 그때그때 꺼낸다 — 훅 바깥에 잡아 두면 로그아웃·커뮤니티 전환으로
    // 클라이언트가 갈릴 때 옛 토큰으로 계속 묻는다(`agentTurns.ts` 와 같은 이유).
    shared = { kind: 'known', view: await getController().api.collabProposals() };
  } catch (err) {
    // 사유를 지어내지 않는다. 화면이 원인을 만들면 사람은 서버 로그를 볼 이유를 잃는다.
    shared = { kind: 'unknown', reason: err instanceof Error ? err.message : String(err) };
  }
  for (const listener of listeners) listener(shared);
}

export function useCollabProposals(enabled: boolean): CollabSnapshot {
  const [snapshot, setSnapshot] = useState<CollabSnapshot>(shared);
  useEffect(() => {
    if (!enabled) return;
    listeners.add(setSnapshot);
    setSnapshot(shared);
    if (!timer) {
      void askOnce();
      timer = setInterval(() => { void askOnce(); }, COLLAB_POLL_MS);
    }
    return () => {
      listeners.delete(setSnapshot);
      if (listeners.size || !timer) return;
      clearInterval(timer);
      timer = null;
      // 마지막 구독자가 떠나면 답을 버린다 — 다시 열었을 때 몇 분 전 목록이 먼저 서면
      // 그것은 "지금 무엇이 막혀 있나" 라는 이 칸의 물음에 거짓으로 답한다.
      shared = { kind: 'checking' };
    };
  }, [enabled]);
  return enabled ? snapshot : { kind: 'checking' };
}

/**
 * 목록의 거르개. 문서(`desktop-collab.html`)의 셋 그대로다: `열림 · 승인됨 · 전부`.
 *
 * **`unknown` 은 열림 쪽에 둔다.** 상태를 모르는 제안을 "끝난 것" 칸에 넣으면 사람이 다시
 * 볼 일이 없어지는데, 모른다는 것은 아직 볼 것이 남았다는 뜻이다.
 */
export type CollabFilter = 'open' | 'accepted' | 'all';

export function matchesFilter(p: CollabProposal, filter: CollabFilter): boolean {
  if (filter === 'all') return true;
  const done = p.state === 'accepted' || p.state === 'rejected';
  return filter === 'accepted' ? done : !done;
}

/** 거른 뒤에도 저장소 묶음은 남긴다 — 저장소가 목록에서 사라지면 "안 보이는 것"과 "없는 것"이 같아진다. */
export function filterRepos(repos: CollabRepoView[], filter: CollabFilter): CollabRepoView[] {
  return repos.map((r) => ({ ...r, proposals: r.proposals.filter((p) => matchesFilter(p, filter)) }));
}

/** 거르개 옆의 수. 저장소를 가로질러 센다 — 사람이 묻는 것은 "내가 볼 것이 몇 개인가" 다. */
export function countFor(repos: CollabRepoView[], filter: CollabFilter): number {
  let n = 0;
  for (const r of repos) for (const p of r.proposals) if (matchesFilter(p, filter)) n += 1;
  return n;
}
