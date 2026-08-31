import { useMemo } from 'react';
import { useAppStore } from '../state/appStore';

const shortActor = (keyId: string) => (keyId.length > 12 ? `${keyId.slice(0, 12)}…` : keyId);

export function LeasePanel() {
  const leases = useAppStore((s) => s.leases);
  const byRepo = useMemo(() => {
    const groups = new Map<string, typeof leases>();
    for (const l of leases) groups.set(l.repo, [...(groups.get(l.repo) ?? []), l]);
    return [...groups.entries()];
  }, [leases]);

  return (
    <div>
      <div className="px-2 pb-1 text-[11px] uppercase tracking-wide text-zinc-500">Active work</div>
      {byRepo.length === 0 && <div className="px-2 text-xs text-zinc-600">No active work</div>}
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
    </div>
  );
}
