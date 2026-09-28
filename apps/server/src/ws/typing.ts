/**
 * 누가 어느 채널에서 입력 중인지. 인메모리이고 DB 에 남기지 않는다 — 수명이 몇 초이고,
 * 서버가 재시작하면 '입력 중'이 사라지는 것이 맞는 상태다.
 *
 * **만료가 핵심이다.** 타이핑에는 "멈췄다"는 신호가 도착하지 않는 경로가 있다 — 탭을 닫거나
 * 네트워크가 끊기면 stop 이 오지 않는다. 만료가 없으면 '입력 중'이 영원히 남고, 사람은 그걸
 * "저 사람이 지금 뭔가 쓰고 있다"로 읽는다.
 */
export interface TypingRegistry {
  /** 입력 중임을 기록하거나 창을 연장한다. */
  mark(channelId: string, accountId: string): void;
  /** 즉시 지운다 — 메시지를 보냈거나 입력을 비웠을 때. */
  clear(channelId: string, accountId: string): void;
  /** 이 사람을 모든 채널에서 지운다 — 소켓이 닫혔을 때. */
  forget(accountId: string): void;
  /**
   * 이 사람이 입력 중으로 남아 있는 채널들. `forget` 전에 읽어야 어느 채널에 다시 알릴지
   * 알 수 있다 — 지운 뒤에는 알 방법이 없다.
   */
  channelsOf(accountId: string): string[];
  /** 지금 입력 중인 사람들. 만료된 항목은 읽는 김에 정리한다. */
  who(channelId: string): string[];
  /**
   * 보관 중인 채널 맵 수. 만료 정리가 실제로 도는지 확인하는 데만 쓴다.
   * **항목 수가 아니라 채널 수인 이유**: 항목만 세면 비워진 채널 맵이 쌓이는 누수를
   * 놓친다(채널이 많은 워크스페이스에서 무한히 는다).
   */
  size(): number;
}

export function createTypingRegistry(
  opts: { ttlMs: number; now?: () => number },
): TypingRegistry {
  const now = opts.now ?? Date.now;
  // channelId → (accountId → 만료 시각)
  const byChannel = new Map<string, Map<string, number>>();

  const sweep = (channelId: string, seen: Map<string, number>) => {
    const t = now();
    for (const [accountId, expires] of seen) {
      if (expires <= t) seen.delete(accountId);
    }
    // 빈 채널 맵을 남기면 채널 수만큼 메모리가 는다.
    if (!seen.size) byChannel.delete(channelId);
  };

  return {
    mark(channelId, accountId) {
      const seen = byChannel.get(channelId) ?? new Map<string, number>();
      seen.set(accountId, now() + opts.ttlMs);
      byChannel.set(channelId, seen);
    },

    clear(channelId, accountId) {
      const seen = byChannel.get(channelId);
      if (!seen) return;
      seen.delete(accountId);
      if (!seen.size) byChannel.delete(channelId);
    },

    forget(accountId) {
      for (const [channelId, seen] of [...byChannel]) {
        seen.delete(accountId);
        if (!seen.size) byChannel.delete(channelId);
      }
    },

    channelsOf(accountId) {
      const found: string[] = [];
      for (const [channelId, seen] of byChannel) {
        if (seen.has(accountId)) found.push(channelId);
      }
      return found;
    },

    who(channelId) {
      const seen = byChannel.get(channelId);
      if (!seen) return [];
      sweep(channelId, seen);
      return [...seen.keys()];
    },

    size() {
      return byChannel.size;
    },
  };
}
