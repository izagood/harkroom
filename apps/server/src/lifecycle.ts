/**
 * 프로세스 종료(SIGTERM)를 in-flight long-poll에 전달하는 단일 지점.
 *
 * MCP `/mcp` 핸들러는 `reply.hijack()`으로 raw 소켓을 가져가므로 Fastify `close()`의 in-flight
 * 대기 대상에서 빠진다. 그래서 종료 시 진행 중인 inbox.poll은 "타임아웃 → 빈 결과"가 아니라
 * transport error로 절단됐다 — 에이전트 쪽 poll 루프를 죽일 수 있는 유일한 경로였다.
 * drain은 그 절단을 정상 종료(빈 결과 200)로 바꾼다.
 */
export class Lifecycle {
  private draining = false;
  private wakers = new Set<() => void>();
  private inFlight = 0;
  private idleWaiters = new Set<() => void>();

  isDraining(): boolean {
    return this.draining;
  }

  /** long-poll이 park하기 전에 호출하고, 반환된 release를 finally에서 부른다. */
  enterPoll(): () => void {
    this.inFlight += 1;
    let released = false;
    return () => {
      if (released) return; // 이중 release가 카운터를 음수로 만들지 않게 한다
      released = true;
      this.inFlight -= 1;
      if (this.inFlight === 0) {
        for (const waiter of [...this.idleWaiters]) waiter();
      }
    };
  }

  /**
   * drain이 시작되면 깨어난다. **이미 draining이면 즉시 호출**한다 — 종료 중에 도착한 poll이
   * park해 버리면 그 park가 곧 절단이 되므로, 등록 자체가 즉시 깨어나기여야 한다.
   */
  onDrain(wake: () => void): () => void {
    if (this.draining) {
      wake();
      return () => {};
    }
    this.wakers.add(wake);
    return () => {
      this.wakers.delete(wake);
    };
  }

  /** drain을 알리고 in-flight long-poll이 모두 응답을 마칠 때까지(최대 graceMs) 기다린다. */
  async beginDrain(graceMs = 2_000): Promise<void> {
    this.draining = true;
    for (const wake of [...this.wakers]) wake();
    this.wakers.clear();
    if (this.inFlight === 0) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.idleWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, graceMs);
      this.idleWaiters.add(finish);
    });
  }
}
