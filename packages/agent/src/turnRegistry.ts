// "이 스레드에 지금 어떤 턴이 돌고 있는가"의 유일한 진실 원천(#337).
//
// 인메모리다 — 프로세스가 곧 턴이라(스펙 §1: PTY 는 뷰, 세션은 디스크) 러너가 죽으면
// 턴도 함께 죽고, 재시작한 러너에게 옛 레지스트리는 전부 거짓이 된다. 디스크에 남기면
// 그 거짓이 살아남아 "죽은 인터랙티브 턴이 조종 중"이라는 이유로 멘션이 영원히 유예된다.
//
// 소비자는 둘이다:
// - `interactiveTurn.ts` 의 3분기 — 멘션 턴 진행 중이면 그 PTY 에 attach, 인터랙티브
//   진행 중이면 기존 세션 반환, 없으면 새로 연다.
// - `main.ts` 의 멘션 유예 — kind 가 'interactive' 인 스레드의 멘션은 markRead 없이
//   건너뛴다(스펙 §5-2 결정 6).
// 두 소비자가 각자 상태를 들면 겹침(같은 세션에 PTY 둘)이 생기므로 여기 하나로 모은다.
import type { TurnMode } from './turn.js';

export interface TurnRecord {
  kind: TurnMode;
  /**
   * 이 턴을 attach 로 보는 릴레이 세션 id. 릴레이가 없는 멘션 턴은 null 이다 — 관찰이
   * 없어도 턴의 존재는 등록돼야 유예 판정이 성립한다(관찰과 답은 다른 실패다, relay.ts).
   */
  sessionId: string | null;
  /** 인터랙티브 턴에서만 — 터미널을 연 사람의 handle. 멘션 유예 통지 문구에 들어간다. */
  openedByHandle?: string;
}

export class TurnRegistry {
  private turns = new Map<string, TurnRecord>();

  /**
   * 턴 시작에 등록한다. 같은 스레드에 이미 턴이 있으면 **크게 던진다** — 조용히
   * 덮어쓰면 첫 턴의 finally(release)가 둘째 턴의 등록을 지워, 둘째 턴이 도는 동안
   * 레지스트리가 "아무 턴도 없다"고 말한다. 그러면 유예가 풀려 같은 세션에 PTY 가
   * 둘 뜬다 — 스펙 §1 이 금지한 정확히 그 모양이다.
   */
  register(threadKey: string, rec: TurnRecord): void {
    const existing = this.turns.get(threadKey);
    if (existing) {
      throw new Error(
        `TurnRegistry: '${threadKey}' 에 이미 ${existing.kind} 턴이 등록돼 있다 — ` +
          '호출자가 3분기(interactiveTurn)나 유예(main 루프)를 건너뛴 결함이다',
      );
    }
    this.turns.set(threadKey, rec);
  }

  /** 턴의 finally 가 부른다. 없는 키를 지우는 것은 무해하다(이미 끝난 턴의 중복 정리). */
  release(threadKey: string): void {
    this.turns.delete(threadKey);
  }

  get(threadKey: string): TurnRecord | undefined {
    return this.turns.get(threadKey);
  }

  /** 이 종류의 턴이 도는 스레드들. 러너 SIGTERM 시 인터랙티브 PTY 회수 경로가 순회한다. */
  *keysOf(kind: TurnMode): IterableIterator<string> {
    for (const [key, rec] of this.turns) {
      if (rec.kind === kind) yield key;
    }
  }
}
