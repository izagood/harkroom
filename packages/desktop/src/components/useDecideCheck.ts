import { useEffect, useState } from 'react';
import { compareRelease } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import type { ApiClient, DecideCheck } from '../lib/api';

/** `GET /agents/:id/decide-check` 가 서버에 들어간 릴리스(P1 #1662). 그 앞 서버에는 묻지 않는다 — 지금처럼 소유자만 정하는 꼴이다. */
export const DECIDE_CHECK_SINCE = '0.4.315';

/**
 * (에이전트, 채널)마다 한 번 묻는다 — 같은 에이전트·채널의 카드는 답이 같다(P1: 판정은 사람·에이전트·채널로만 갈린다).
 * 커뮤니티마다 ApiClient 가 따로라 그 객체에 묶는다. 실패한 물음은 지워 다음 그리기에서 다시 묻는다.
 */
const cache = new WeakMap<ApiClient, Map<string, Promise<DecideCheck | null>>>();

function ask(api: ApiClient, agentId: string, channelId: string): Promise<DecideCheck | null> {
  let byKey = cache.get(api);
  if (!byKey) { byKey = new Map(); cache.set(api, byKey); }
  const key = `${agentId}:${channelId}`;
  const hit = byKey.get(key);
  if (hit) return hit;
  const p = api.decideCheck(agentId, channelId).catch(() => {
    byKey!.delete(key);
    return null;
  });
  byKey.set(key, p);
  return p;
}

/** 시험에서 캐시를 비운다. */
export function resetDecideCheckCache(api: ApiClient): void {
  cache.delete(api);
}

/**
 * 이 사람이 이 카드를 정할 수 있나(designer 시안 v2 ②·③). 받기 전·옛 서버·실패면 null — 부르는 쪽은 지금처럼 소유자만 꼴로 그린다.
 * 버튼은 화면의 힌트일 뿐이고 판정은 누를 때 서버(`decide` → `mayDecideFor`)가 다시 한다.
 */
export function useDecideCheck(agentId: string | null, channelId: string | null): DecideCheck | null {
  const serverVersion = useActiveStore((s) => s.serverVersion?.version ?? null);
  const meId = useActiveStore((s) => s.me?.id ?? null);
  const supported = serverVersion !== null && (compareRelease(serverVersion, DECIDE_CHECK_SINCE) ?? -1) >= 0;
  const [value, setValue] = useState<{ key: string; v: DecideCheck | null } | null>(null);
  const key = supported && agentId && channelId && meId ? `${meId}:${agentId}:${channelId}` : null;
  useEffect(() => {
    if (!key || !agentId || !channelId) return;
    let alive = true;
    void ask(getController().api, agentId, channelId).then((v) => { if (alive) setValue({ key, v }); });
    return () => { alive = false; };
  }, [key, agentId, channelId]);
  return key && value?.key === key ? value.v : null;
}
