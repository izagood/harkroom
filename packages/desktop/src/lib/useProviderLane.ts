/**
 * API 키 연결(코드 이름 provider lane, `@harkroom/shared/providerLane`) — 실행 탭이 읽는 이 기기의 설정·마지막 키 받기 결과·
 * 이 에이전트에 허락된 비밀.
 *
 * - **설정은 이 기기의 오퍼레이터 로컬 설정(`operator.json`)에만 있다.** 서버 정의에 없으므로 다른 기기로 옮기면 따라가지
 *   않는다(security ⓓ「이 맥의 데스크톱에서만」). 그래서 이 맥의 로컬 설정에 이 에이전트가 없으면(`present: false`) 고를 수
 *   없다 — 넣으면 그 에이전트를 이 맥에서 돌릴 수 있게 되는 부작용이 있다(`localAgents.setProviderLane` 이 자리를 만든다).
 * - **허락된 비밀만** 고른다(security n2). 비밀마다 `GET /secrets/:id/grants` 를 읽어 이 에이전트의 grant 가 있는 것만 남긴다.
 *   한 비밀의 grant 를 못 읽으면 목록에서 빼지 않고 `unreadable` 로 둔다 — 빼면 「허락이 없다」로 읽힌다.
 * - 저장은 사람의 클릭에서만(`save`) — 이 훅은 스스로 쓰지 않는다.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ProviderLaneConfig, ProviderLaneStatus } from '@harkroom/shared/providerLane';
import type { SecretView } from './api';
import { getController } from '../state/controller';
import { hasOperatorLocalSurface, listLocalAgents, onLocalAgentsChanged, setLocalAgentProviderLane } from './operatorLocal';

export interface LaneSecretOption {
  id: string;
  name: string;
  expiresAt: string | null;
  /** 이 에이전트의 grant 가 있다(정지 아님). */
  granted: boolean;
  /** grant 가 정지돼 있다. */
  suspended: boolean;
  /** grant 를 특정 채널에만 줬다 — 그 밖 채널의 턴은 키를 못 받는다. */
  channelLimited: boolean;
  /** 이 비밀의 grant 를 못 읽었다. */
  unreadable: boolean;
}

export interface ProviderLaneState {
  /** Tauri 표면이 있고 로컬 설정을 읽었다. */
  available: boolean;
  /** 이 맥의 로컬 설정에 이 에이전트가 있다. */
  present: boolean;
  lane: ProviderLaneConfig | null;
  status: ProviderLaneStatus | null;
  /**
   * 「적용 대기」 — 오퍼레이터가 이 에이전트의 새 턴을 막고 있다(러너 모드가 설정과 달라 다시 뜨기 전, C1). 오퍼레이터의 턴 자리 문과
   * 같은 판정을 그대로 받는다(designer s1) — 앱이 따로 셈하지 않는다.
   */
  pending: boolean;
  /** 「적용 대기」가 처음 보인 시각(ms) — 오래가면 화면이 [재시작]을 낸다(n14). 대기가 아니면 null. */
  pendingSince: number | null;
  /** null = 아직 안 읽음. */
  secrets: LaneSecretOption[] | null;
  /** 비밀 목록 자체를 못 읽었다(빈 목록과 다르다). */
  secretsError: string | null;
  error: string | null;
  reload(): void;
  save(lane: ProviderLaneConfig | null): Promise<void>;
}

export function useProviderLane(agentId: string | null): ProviderLaneState {
  const [tick, setTick] = useState(0);
  const [present, setPresent] = useState(false);
  const [available, setAvailable] = useState(false);
  const [lane, setLane] = useState<ProviderLaneConfig | null>(null);
  const [status, setStatus] = useState<ProviderLaneStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [secrets, setSecrets] = useState<LaneSecretOption[] | null>(null);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const baseUrl = getController().api?.baseUrl ?? null;

  useEffect(() => onLocalAgentsChanged(() => setTick((n) => n + 1)), []);

  useEffect(() => {
    if (!agentId || !baseUrl || !hasOperatorLocalSurface()) { setAvailable(false); return; }
    let live = true;
    void listLocalAgents()
      .then((r) => {
        if (!live) return;
        const entry = r.communities.find((c) => c.baseUrl === baseUrl)?.agents[agentId];
        setAvailable(true);
        setPresent(entry !== undefined);
        setLane(entry?.providerLane ?? null);
        setStatus(r.laneStatus?.[agentId] ?? null);
        const nextPending = r.lanePending?.[agentId] === true;
        setPending(nextPending);
        setPendingSince((prev) => (nextPending ? (prev ?? Date.now()) : null));
        setError(null);
      })
      .catch((e: unknown) => { if (live) { setAvailable(false); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; };
  }, [agentId, baseUrl, tick]);

  useEffect(() => {
    // 고를 수 있을 때만 읽는다(이 맥에 이 에이전트가 있을 때) — 비밀마다 grants 를 읽으므로 공짜가 아니다.
    if (!agentId || !available || !present) return;
    let live = true;
    setSecrets(null);
    void Promise.resolve()
      .then(() => getController().listSecrets())
      .then(async (r: { enabled: boolean; secrets: SecretView[] }) => {
        const rows = await Promise.all(r.secrets.map(async (s): Promise<LaneSecretOption | null> => {
          try {
            const grants = (await getController().listSecretGrants(s.id)).filter((g) => g.agentId === agentId);
            if (!grants.length) return null;
            const active = grants.filter((g) => g.suspendedAt === null);
            return {
              id: s.id, name: s.name, expiresAt: s.expiresAt,
              granted: active.length > 0, suspended: active.length === 0,
              channelLimited: active.length > 0 && active.every((g) => g.channelId !== null),
              unreadable: false,
            };
          } catch {
            return { id: s.id, name: s.name, expiresAt: s.expiresAt, granted: false, suspended: false, channelLimited: false, unreadable: true };
          }
        }));
        if (!live) return;
        setSecrets(rows.filter((x): x is LaneSecretOption => x !== null));
        setSecretsError(null);
      })
      .catch((e: unknown) => { if (live) { setSecrets([]); setSecretsError(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; };
  }, [agentId, available, present, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  // 적용 대기 동안은 다시 읽는다 — 러너가 다시 뜨면 오퍼레이터의 모드가 바뀌고 이 줄이 사라져야 한다.
  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 5_000);
    return () => window.clearInterval(id);
  }, [pending]);
  const save = useCallback(async (next: ProviderLaneConfig | null) => {
    if (!agentId || !baseUrl) return;
    await setLocalAgentProviderLane(baseUrl, agentId, next);
  }, [agentId, baseUrl]);

  return { available, present, lane, status, pending, pendingSince, secrets, secretsError, error, reload, save };
}
