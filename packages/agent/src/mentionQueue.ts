// 사람이 조종 중인 스레드의 멘션 대기 장부(#337, 스펙 §5-2 결정 6·7).
//
// **큐가 아니다 — 큐는 서버 inbox 다.** 조종 중 스레드의 멘션을 markRead 도 attempts
// 증가도 없이 건너뛰면, inbox 의 at-least-once 가 그대로 큐가 된다: 다음 폴이 같은
// entry 를 다시 내주고, 인터랙티브가 끝나면 그 폴이 정상 처리된다. 러너가 재시작하면
// 인터랙티브 PTY 도 함께 죽으므로(프로세스=턴) 이 장부가 인메모리로 사라지는 것이
// 정확히 맞다 — 유예 사유가 사라졌으니 장부도 사라져야 한다.
//
// 여기 드는 것은 유예가 만드는 관측 문제들의 답이다:
// ① 통지 중복 — 같은 entry 가 배치마다 다시 오는데 그때마다 "대기 중" 을 올리면
//    조종이 길수록 스레드가 도배된다. entry 당 1회만 통지한다.
// ② lastFedSeq 클램프 재료 — 인터랙티브 종료 시 lastFedSeq 를 대기 멘션의
//    min seq − 1 로 클램프해야 하고(결정 7), 그 min 이 여기 있다.
// ③ **유예가 얼마나 오래됐는가** — 유예에는 상한이 없어서(inbox 가 큐이므로 잃지는
//    않는다) 조종이 풀리지 않으면 그 스레드는 조용히 영구 정지한다. 실측된 결함이
//    정확히 그것이었다: 뷰어 수 프레임 하나가 유실돼 인터랙티브 턴이 안 끝났고, 대기가
//    1→2→3 으로 늘어나는 것 말고는 아무 신호가 없었다. 그래서 이 장부가 **에피소드의
//    시작 시각**과 **경고를 이미 냈는가**를 함께 든다 — 상한 판정은 스케줄러가 하지만,
//    그 재료는 통지 중복 판정과 같은 자리에 있어야 한다(둘 다 "이 조종 동안" 의 사실이다).

/** 한 번의 조종(=인터랙티브 턴 하나) 동안의 대기 장부. `clear` 가 에피소드를 닫는다. */
interface Episode {
  /** entryId → 그 멘션의 seq. */
  entries: Map<number, number>;
  /** 이 에피소드에서 처음 유예한 시각(ms). 경과는 여기서 잰다. */
  since: number;
  /** 상한 경고를 이미 냈는가 — 폴마다 다시 내면 그 경고가 곧 도배가 된다. */
  warned: boolean;
}

export interface DeferResult {
  /** 이 entry 의 **첫** 유예인가. 대기 통지는 이때만 올린다. */
  shouldNotify: boolean;
  /** 지금 이 스레드에 대기 중인 멘션 수(통지 문구의 N). */
  pending: number;
  /** 이 조종이 멘션을 붙잡고 있는 시간(ms). 첫 유예에서는 0 이다. */
  heldMs: number;
  /** 상한 경고를 이미 냈는가. */
  warned: boolean;
}

export class MentionQueue {
  private byThread = new Map<string, Episode>();

  /**
   * 멘션 하나를 유예로 기록한다.
   *
   * `at` 을 인자로 받는다 — 스케줄러가 이미 주입 가능한 시계를 들고 있고(`deps.now`),
   * 이 장부가 `Date.now` 를 직접 부르면 상한 회귀선이 실시간을 기다려야 한다.
   */
  defer(threadKey: string, entryId: number, seq: number, at: number): DeferResult {
    let episode = this.byThread.get(threadKey);
    if (!episode) {
      episode = { entries: new Map(), since: at, warned: false };
      this.byThread.set(threadKey, episode);
    }
    const shouldNotify = !episode.entries.has(entryId);
    episode.entries.set(entryId, seq);
    return {
      shouldNotify,
      pending: episode.entries.size,
      // 시계가 뒤로 갈 수 있다(주입된 것이든 NTP 든) — 음수 경과를 상한 판정에 넣지 않는다.
      heldMs: Math.max(0, at - episode.since),
      warned: episode.warned,
    };
  }

  /** 상한 경고를 냈다고 적는다. 에피소드당 1회라는 약속이 이 한 줄이다. */
  markWarned(threadKey: string): void {
    const episode = this.byThread.get(threadKey);
    if (episode) episode.warned = true;
  }

  /** 대기 멘션의 최소 seq. 없으면 null — 클램프할 것이 없다는 뜻이다. */
  minSeq(threadKey: string): number | null {
    const episode = this.byThread.get(threadKey);
    if (!episode?.entries.size) return null;
    return Math.min(...episode.entries.values());
  }

  /**
   * 인터랙티브가 끝났다 — 장부를 지운다. 다음 조종에서 같은 entry 가 다시 유예되면
   * 그것은 **새 통지**다: 새로 조종을 시작한 사람이 있다는 새 사실이고, 옛 통지는
   * 옛 조종의 것이다. 경과와 경고 플래그가 같이 지워지는 것도 같은 이유다.
   */
  clear(threadKey: string): void {
    this.byThread.delete(threadKey);
  }
}
