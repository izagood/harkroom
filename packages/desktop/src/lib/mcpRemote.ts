/**
 * 원격 operator 의 MCP 상태 — 박동 `status.mcp`(#1451)를 화면 말로 옮긴다(MCP 설정 시안 v2 §2·§6·§7, PR5).
 *
 * 박동은 **주인에게만** 실린다(서버가 가린다). 이름은 그 operator 에 배정된 에이전트가 켠 것만 실리므로, 목록에 없는
 * 이름은 「없다」가 아니라 「모른다」다. 값(URL·Client ID·토큰)은 박동에 없다 — 지문(`clientIdFp`)만 있다.
 */
import { useEffect, useState } from 'react';
import type { OperatorMcpStatusEntry, OperatorView } from '@harkroom/shared';
import { getController } from '../state/controller';
import { useActiveStore, useCommunityRegistry } from '../state/communities';

export type RemoteMcpState =
  | { kind: 'offline'; lastSeenAt: string | null }
  | { kind: 'unknown' }
  | { kind: 'missing' }
  | { kind: 'defined'; entry: OperatorMcpStatusEntry };

/** 그 operator 에서 이 이름의 상태. */
export function remoteMcpState(op: OperatorView, name: string): RemoteMcpState {
  if (!op.online) return { kind: 'offline', lastSeenAt: op.lastSeenAt };
  const list = op.status?.mcp;
  if (!list) return { kind: 'unknown' };
  const entry = list.find((e) => e.name === name);
  if (!entry) return { kind: 'unknown' };
  return entry.defined ? { kind: 'defined', entry } : { kind: 'missing' };
}

/**
 * 내가 주인인 operator 들(시안 D8) — 거둔 것은 뺀다. `null` = 아직 모름·못 읽음(원격 칸을 그리지 않는다).
 * 지금 커뮤니티가 바뀌면 다시 읽는다.
 */
export function useOwnedOperators(): OperatorView[] | null {
  const meId = useActiveStore((s) => s.me?.id ?? null);
  const activeKey = useCommunityRegistry((r) => r.activeId);
  const [ops, setOps] = useState<OperatorView[] | null>(null);
  useEffect(() => {
    let live = true;
    setOps(null);
    if (!meId) return;
    void Promise.resolve().then(() => getController().operators())
      .then((rows) => { if (live) setOps(rows.filter((o) => o.ownerAccountId === meId && !o.revokedAt)); })
      .catch(() => { if (live) setOps(null); });
    return () => { live = false; };
  }, [meId, activeKey]);
  return ops;
}

/**
 * Client ID 지문 — 오퍼레이터 `heartbeat.ts::clientIdFingerprint` 와 **같은 식**이다:
 * `sha256("harkroom-mcp-client:" + 서버 주소 + "\n" + clientId)` 앞 16 hex. 웹뷰라 WebCrypto 로 잰다.
 * 서버 주소는 오퍼레이터가 쓰는 커뮤니티 주소(`operator.json` 의 키)와 같은 값 — 데스크톱 레지스트리의 baseUrl 이다.
 */
export async function clientIdFingerprint(baseUrl: string, clientId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`harkroom-mcp-client:${baseUrl}\n${clientId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** 지금 커뮤니티의 서버 주소(레지스트리 값, 아직 없으면 컨트롤러 값). 모르면 null. */
export function useActiveBaseUrl(): string | null {
  const fromRegistry = useCommunityRegistry((r) => r.entries.find((e) => e.id === r.activeId)?.baseUrl || null);
  return fromRegistry ?? getController().api?.baseUrl ?? null;
}
