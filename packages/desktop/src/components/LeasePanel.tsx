import { useMemo } from 'react';
import { PROJECTION_UNCONFIGURED_DETAIL, PROJECTION_UNCONFIGURED_HEADLINE } from '@murmur/shared';
import { useActiveStore } from '../state/communities';

const shortActor = (keyId: string) => (keyId.length > 12 ? `${keyId.slice(0, 12)}…` : keyId);

/** "N분 전". 1분 미만은 '방금' 이다 — "0분 전"은 사람이 쓰지 않는 말이다. */
function minutesAgo(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return '방금';
  return `${minutes}분 전`;
}

/**
 * ACTIVE WORK 영역(#267).
 *
 * **`docs/design.md` §4: "없다"와 "못 읽었다"를 한 화면에 두지 않는다.** 이 영역이
 * 그 기준을 어기기 쉬운 자리다 — 빈 목록 하나가 네 가지 사정을 뭉갤 수 있다:
 *
 * 1. 투영이 아예 꺼져 있다(`AVCS_BASE_URL` 이 없다)
 * 2. 투영이 멈췄다(폴링이 5분 넘게 안 돌았거나 마지막 시도가 실패했다)
 * 3. 투영 상태 자체를 못 읽었다(`/projection/status` 요청이 실패했다)
 * 4. 정말로 지금 잡힌 작업이 없다
 *
 * 넷을 한 문구("No active work")로 그리면 도그푸딩 중에 투영이 끊긴 것을 아무도
 * 모른다 — 화면이 평소와 똑같기 때문이다. 그래서 "No active work" 는 **오직 4번**,
 * 즉 상태를 읽었고 그 상태가 `ok` 일 때만 쓴다.
 *
 * 목록이 비어 있지 않으면 목록을 그린다 — 실제 데이터가 상태 문구보다 먼저다. 다만
 * 비정상 상태의 배너는 목록 **위에** 함께 남긴다: 투영이 멈춘 동안 남아 있던 리스는
 * 지금 벌어지는 일이 아닐 수 있고, 그것을 말없이 '활성 작업'으로 보여 주면 화면이
 * 오래된 사실을 지금 사실로 주장하게 된다.
 */
export function LeasePanel() {
  const leases = useActiveStore((s) => s.leases);
  const projectionStatus = useActiveStore((s) => s.projectionStatus);
  const projectionStatusError = useActiveStore((s) => s.projectionStatusError);
  const byRepo = useMemo(() => {
    const groups = new Map<string, typeof leases>();
    for (const l of leases) groups.set(l.repo, [...(groups.get(l.repo) ?? []), l]);
    return [...groups.entries()];
  }, [leases]);

  /**
   * 비정상 상태를 말하는 한 줄. 정상(`ok`)이면 `null` 이다.
   *
   * 순서가 뜻을 정한다: **못 읽은 것이 먼저다.** 마지막으로 성공한 상태가 남아 있어도
   * 그것은 지금의 사실이 아니므로, 지금 못 읽고 있다는 것을 먼저 말한다.
   */
  const banner = (() => {
    if (projectionStatusError !== null) {
      return {
        testid: 'projection-unreadable',
        tone: 'text-danger',
        text: '투영 상태를 읽지 못했다',
        detail: projectionStatusError,
      };
    }
    // 아직 첫 응답이 오지 않았다. "없다"가 아니라 "아직 모른다"다.
    if (projectionStatus === null) {
      return {
        testid: 'projection-unknown',
        tone: 'text-fg-subtle',
        text: '투영 상태를 확인하는 중…',
        detail: null,
      };
    }
    if (projectionStatus.state === 'unconfigured') {
      return {
        testid: 'projection-unconfigured',
        tone: 'text-warning',
        text: PROJECTION_UNCONFIGURED_HEADLINE,
        detail: PROJECTION_UNCONFIGURED_DETAIL,
      };
    }
    if (projectionStatus.state === 'stalled') {
      // 폴링을 한 번도 못 했으면 "N분 전"이라고 말할 수 없다 — 모르는 것을 숫자로
      // 꾸미지 않는다.
      const since = projectionStatus.lastPolledAt === null
        ? '언제부터인지 알 수 없지만'
        : `${minutesAgo(projectionStatus.lastPolledAt)}부터`;
      return {
        testid: 'projection-stalled',
        tone: 'text-warning',
        text: `투영이 ${since} 멈춰 있다`,
        detail: projectionStatus.lastError,
      };
    }
    return null;
  })();

  return (
    <div>
      <div className="px-2 pb-1 text-[11px] uppercase tracking-wide text-fg-subtle">Active work</div>
      {banner && (
        <div data-testid={banner.testid} className="space-y-0.5 px-2 pb-1">
          <div className={`text-xs ${banner.tone}`}>{banner.text}</div>
          {banner.detail && (
            // 에러 원문은 길 수 있다. 잘라서 보여 주되 `title` 로 전문을 남긴다 —
            // 잘린 채로만 두면 무엇이 잘못됐는지 화면에서 알 수 없다.
            <div className="truncate text-xs text-fg-subtle" title={banner.detail}>
              {banner.detail}
            </div>
          )}
        </div>
      )}
      {/* "No active work" 는 **상태를 읽었고 정상일 때만** 쓴다. 그 밖의 경우는 위
          배너가 왜 비어 있는지 이미 말했고, 거기에 "없다"를 덧붙이면 읽지도 못한
          것을 없다고 단정하는 셈이다. */}
      {byRepo.length === 0 && banner === null && (
        <div className="px-2 text-xs text-fg-muted">No active work</div>
      )}
      {byRepo.map(([repo, rows]) => (
        <div key={repo} className="px-2 pb-1">
          <div className="text-xs font-semibold text-fg-muted">{repo}</div>
          {rows.map((l) => (
            <div key={`${l.path}:${l.actorKeyId}`} className="truncate text-xs text-fg-subtle">
              {l.path} — {shortActor(l.actorKeyId)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
