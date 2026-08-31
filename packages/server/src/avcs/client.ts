// avcs self-hosted 프로토콜 wire 가정은 이 파일에만 둔다.
// 프로토콜 스펙이 확정되면 이 파일만 스펙에 맞춰 교체한다 (스펙 버전 핀: v0-dev).

export interface AvcsLogEntry {
  logIndex: number;
  oid: string;
  type: 'intent' | 'operation' | 'decision' | 'evidence' | 'integration' | 'checkpoint' | 'release' | 'finalize' | 'lease';
  actorKeyId: string | null;
  intentOid: string | null;
  summary: string;
  lease?: { path: string; expiresAt: string; released: boolean };
}

export interface AvcsServerClient {
  waitForChange(repo: string, since: number, timeoutMs: number): Promise<boolean>;
  fetchSince(repo: string, since: number): Promise<{ entries: AvcsLogEntry[]; next: number }>;
}

export function httpAvcsClient(baseUrl: string): AvcsServerClient {
  const base = baseUrl.replace(/\/$/, '');
  return {
    async waitForChange(repo, since, timeoutMs) {
      const res = await fetch(
        `${base}/${encodeURIComponent(repo)}/events?since=${since}&timeoutMs=${timeoutMs}`,
        { signal: AbortSignal.timeout(timeoutMs + 10_000) },
      );
      if (res.status === 204) return false;
      if (!res.ok) throw new Error(`avcs events failed: ${res.status}`);
      await res.arrayBuffer();
      return true;
    },
    async fetchSince(repo, since) {
      const res = await fetch(`${base}/${encodeURIComponent(repo)}/sync?since=${since}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`avcs sync failed: ${res.status}`);
      const body = (await res.json()) as { version: number; next: number; entries: AvcsLogEntry[] };
      return { entries: body.entries, next: body.next };
    },
  };
}
