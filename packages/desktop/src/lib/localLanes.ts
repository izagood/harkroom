/**
 * 이 맥에서 API 키 연결(provider lane)로 도는 에이전트 — 격자 칩·빨간 점, 터미널 진입점 끄기가 같은 사실을 읽는다.
 *
 * **이 맥의 사실만이다.** 설정은 오퍼레이터 로컬 설정(`operator.json`)에만 있어서 다른 기기에서 도는 lane 에이전트는
 * 여기서 모른다(서버 정의에 없다). 그런 에이전트의 터미널은 러너가 `interactive_unsupported` 로 거절하고, 그 거절은
 * `TerminalPanel` 이 같은 문장으로 바꿔 보여 준다.
 *
 * 메시지마다 `TerminalChip` 이 서므로 컴포넌트마다 소켓을 부르지 않는다 — 한 장의 스냅숏을 모듈에 두고, 구독자가 있는
 * 동안만 바뀜 신호(`onLocalAgentsChanged`)와 30초 주기로 다시 읽는다(마지막 키 받기 결과가 턴마다 바뀐다).
 */
import { useSyncExternalStore } from 'react';
import type { ProviderLaneStatus } from '@harkroom/shared/providerLane';
import { getController } from '../state/controller';
import { hasOperatorLocalSurface, listLocalAgents, onLocalAgentsChanged } from './operatorLocal';

export interface LocalLane {
  status: ProviderLaneStatus | null;
  /** 「적용 대기」 — 오퍼레이터가 새 턴을 막고 있다(C1). 칩에 ⏳ 를 붙인다(designer n13). */
  pending: boolean;
}

type Snapshot = ReadonlyMap<string, LocalLane>;

const EMPTY: Snapshot = new Map();
const REFRESH_MS = 30_000;

let snapshot: Snapshot = EMPTY;
let snapshotBase: string | null = null;
const listeners = new Set<() => void>();
let stopWatching: (() => void) | null = null;
let generation = 0;

function currentBase(): string | null {
  // 메시지 줄마다 불린다 — 컨트롤러가 아직 없는 순간(기동·커뮤니티 전환)에 화면을 깨뜨리지 않는다.
  if (!hasOperatorLocalSurface()) return null;
  try { return getController().api?.baseUrl ?? null; } catch { return null; }
}

function publish(next: Snapshot, base: string | null) {
  snapshot = next;
  snapshotBase = base;
  for (const cb of [...listeners]) cb();
}

function refresh() {
  const base = currentBase();
  if (!base) { if (snapshot !== EMPTY) publish(EMPTY, null); return; }
  const gen = ++generation;
  void listLocalAgents(base).then((r) => {
    if (gen !== generation) return;
    const agents = r.communities.find((c) => c.baseUrl === base)?.agents ?? {};
    const next = new Map<string, LocalLane>();
    for (const [id, a] of Object.entries(agents)) {
      if (a.providerLane) next.set(id, { status: r.laneStatus?.[id] ?? null, pending: r.lanePending?.[id] === true });
    }
    publish(next, base);
  }).catch(() => {
    // 못 읽으면 모른다 — 「lane 아님」으로 확정하지 않고 지난 값을 그대로 둔다. 터미널은 러너 거절이 뒤를 받친다.
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  // 웹·시험에는 오퍼레이터가 없다 — 타이머도 세우지 않는다.
  if (!stopWatching && hasOperatorLocalSurface()) {
    const off = onLocalAgentsChanged(refresh);
    const timer = setInterval(refresh, REFRESH_MS);
    stopWatching = () => { off(); clearInterval(timer); };
    refresh();
  }
  return () => {
    listeners.delete(cb);
    if (!listeners.size && stopWatching) { stopWatching(); stopWatching = null; }
  };
}

function getSnapshot(): Snapshot {
  // 커뮤니티를 바꾸면 다음 읽기 전까지 옛 커뮤니티의 사실을 보이지 않는다.
  if (snapshotBase !== null && snapshotBase !== currentBase()) {
    // 전환 뒤 첫 읽기 — 새 커뮤니티 값을 곧바로 다시 읽는다(30초 주기를 기다리지 않게, security #1640 n2).
    queueMicrotask(refresh);
    return EMPTY;
  }
  return snapshot;
}

/** 이 맥에서 API 키로 도는 에이전트 표(id → 마지막 키 받기 결과). Tauri 표면이 없으면 늘 비어 있다. */
export function useLocalLanes(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

/** 그 에이전트가 이 맥에서 API 키로 도는가. 아니거나 모르면(표면 없음·못 읽음) null. */
export function useLocalLane(agentId: string | null | undefined): LocalLane | null {
  const lanes = useLocalLanes();
  return agentId ? lanes.get(agentId) ?? null : null;
}

/** 시험용 — 모듈 스냅숏을 비운다. */
export function resetLocalLanesForTest() {
  generation++;
  stopWatching?.();
  stopWatching = null;
  listeners.clear();
  snapshot = EMPTY;
  snapshotBase = null;
}
