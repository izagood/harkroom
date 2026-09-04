// 사람이 조종 중인 스레드의 멘션 대기 장부(#337, 스펙 §5-2 결정 6·7).
//
// **큐가 아니다 — 큐는 서버 inbox 다.** 조종 중 스레드의 멘션을 markRead 도 attempts
// 증가도 없이 건너뛰면, inbox 의 at-least-once 가 그대로 큐가 된다: 다음 폴이 같은
// entry 를 다시 내주고, 인터랙티브가 끝나면 그 폴이 정상 처리된다. 러너가 재시작하면
// 인터랙티브 PTY 도 함께 죽으므로(프로세스=턴) 이 장부가 인메모리로 사라지는 것이
// 정확히 맞다 — 유예 사유가 사라졌으니 장부도 사라져야 한다.
//
// 여기 드는 것은 유예가 만드는 두 가지 관측 문제의 답이다:
// ① 통지 중복 — 같은 entry 가 배치마다 다시 오는데 그때마다 "대기 중" 을 올리면
//    조종이 길수록 스레드가 도배된다. entry 당 1회만 통지한다.
// ② lastFedSeq 클램프 재료 — 인터랙티브 종료 시 lastFedSeq 를 대기 멘션의
//    min seq − 1 로 클램프해야 하고(결정 7), 그 min 이 여기 있다.
export class MentionQueue {
  private byThread = new Map<string, Map<number, number>>();

  /**
   * 멘션 하나를 유예로 기록한다. `shouldNotify` 가 true 인 것은 이 entry 의 **첫**
   * 유예뿐이고, `pending` 은 현재 이 스레드에 대기 중인 멘션 수다(통지 문구의 N).
   */
  defer(threadKey: string, entryId: number, seq: number): { shouldNotify: boolean; pending: number } {
    let entries = this.byThread.get(threadKey);
    if (!entries) {
      entries = new Map();
      this.byThread.set(threadKey, entries);
    }
    const shouldNotify = !entries.has(entryId);
    entries.set(entryId, seq);
    return { shouldNotify, pending: entries.size };
  }

  /** 대기 멘션의 최소 seq. 없으면 null — 클램프할 것이 없다는 뜻이다. */
  minSeq(threadKey: string): number | null {
    const entries = this.byThread.get(threadKey);
    if (!entries?.size) return null;
    return Math.min(...entries.values());
  }

  /**
   * 인터랙티브가 끝났다 — 장부를 지운다. 다음 조종에서 같은 entry 가 다시 유예되면
   * 그것은 **새 통지**다: 새로 조종을 시작한 사람이 있다는 새 사실이고, 옛 통지는
   * 옛 조종의 것이다.
   */
  clear(threadKey: string): void {
    this.byThread.delete(threadKey);
  }
}
