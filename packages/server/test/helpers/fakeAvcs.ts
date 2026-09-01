// ProjectionWorker의 검증 대상은 투영 로직이고 transport가 아니다. 그래서 여기서는 wire를
// 흉내내지 않고 AvcsServerClient를 인메모리로 구현한다 — wire는 avcsClient.test.ts가 실제
// avcs-server를 상대로 전담한다. (이전 버전은 fake HTTP 서버로 구 wire를 흉내냈고, 그래서
// 실제 프로토콜과의 불일치가 초록 뒤에 숨어 있었다.)
import type { AvcsLogEntry, AvcsServerClient } from '../../src/avcs/client.js';

export interface FakeAvcs {
  client: AvcsServerClient;
  push(repo: string, entry: Omit<AvcsLogEntry, 'logIndex'>): void;
}

export function createFakeAvcs(): FakeAvcs {
  const logs = new Map<string, AvcsLogEntry[]>();
  const waiters = new Set<() => void>();

  const logOf = (repo: string): AvcsLogEntry[] => logs.get(repo) ?? [];

  const client: AvcsServerClient = {
    async waitForChange(repo, since, timeoutMs) {
      if (logOf(repo).length > since) return true;
      // 실제 서버처럼 타임아웃까지 park한다. 즉시 false를 돌려주면 start() 루프가 열심히 돈다.
      return new Promise<boolean>((resolve) => {
        const finish = (changed: boolean) => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve(changed);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        const wake = (): void => {
          if (logOf(repo).length > since) finish(true);
        };
        waiters.add(wake);
      });
    },

    async fetchSince(repo, since) {
      const log = logOf(repo);
      return { entries: log.filter((e) => e.logIndex > since), next: log.length };
    },
  };

  return {
    client,
    push(repo, entry) {
      const log = logOf(repo);
      log.push({ ...entry, logIndex: log.length + 1 });
      logs.set(repo, log);
      for (const wake of [...waiters]) wake();
    },
  };
}
