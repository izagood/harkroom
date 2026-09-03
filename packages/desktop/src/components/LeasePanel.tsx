import { useMemo } from 'react';
import { useAppStore } from '../state/appStore';

const shortActor = (keyId: string) => (keyId.length > 12 ? `${keyId.slice(0, 12)}…` : keyId);

function formatMinutesAgo(timestamp: number | null): string {
  if (!timestamp) return '알 수 없음';
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '방금';
  if (minutes === 1) return '1분 전';
  return `${minutes}분 전`;
}

export function LeasePanel() {
  const leases = useAppStore((s) => s.leases);
  const projectionStatus = useAppStore((s) => s.projectionStatus);
  const byRepo = useMemo(() => {
    const groups = new Map<string, typeof leases>();
    for (const l of leases) groups.set(l.repo, [...(groups.get(l.repo) ?? []), l]);
    return [...groups.entries()];
  }, [leases]);

  // "없다"와 "못 읽었다"를 한 화면에 두지 않는다 — design.md §4
  const renderContent = () => {
    // 아직 projectionStatus 를 받지 못한 경우 — 읽는 중이라 볼 수 없으니 그대로 둔다.
    if (!projectionStatus) {
      if (byRepo.length === 0) {
        return <div className="px-2 text-xs text-zinc-600">No active work</div>;
      }
      return (
        <>
          {byRepo.map(([repo, rows]) => (
            <div key={repo} className="px-2 pb-1">
              <div className="text-xs font-semibold text-zinc-400">{repo}</div>
              {rows.map((l) => (
                <div key={`${l.path}:${l.actorKeyId}`} className="truncate text-xs text-zinc-500">
                  {l.path} — {shortActor(l.actorKeyId)}
                </div>
              ))}
            </div>
          ))}
        </>
      );
    }
    // 투영이 설정되지 않은 경우
    if (projectionStatus.state === 'unconfigured') {
      return (
        <div className="px-2 text-xs text-amber-400">
          투영이 설정되지 않았다 — AVCS_BASE_URL 로 켜세요
        </div>
      );
    }
    // 투영이 멈춘 경우
    if (projectionStatus.state === 'stalled') {
      const lastPolled = projectionStatus.lastPolledAt
        ? formatMinutesAgo(projectionStatus.lastPolledAt)
        : '알 수 없음';
      return (
        <div className="px-2 space-y-1">
          <div className="text-xs text-amber-400">
            투영이 {lastPolled}부터 멈춰 있다
          </div>
          {projectionStatus.lastError && (
            <div className="text-xs text-red-400 truncate" title={projectionStatus.lastError}>
              {projectionStatus.lastError}
            </div>
          )}
        </div>
      );
    }
    // ok 상태 — 기존 로직
    if (byRepo.length === 0) {
      return <div className="px-2 text-xs text-zinc-600">No active work</div>;
    }
    return (
      <>
        {byRepo.map(([repo, rows]) => (
          <div key={repo} className="px-2 pb-1">
            <div className="text-xs font-semibold text-zinc-400">{repo}</div>
            {rows.map((l) => (
              <div key={`${l.path}:${l.actorKeyId}`} className="truncate text-xs text-zinc-500">
                {l.path} — {shortActor(l.actorKeyId)}
              </div>
            ))}
          </div>
        ))}
      </>
    );
  };

  return (
    <div>
      <div className="px-2 pb-1 text-[11px] uppercase tracking-wide text-zinc-500">Active work</div>
      {renderContent()}
    </div>
  );
}
