import { useMemo } from 'react';
import { useActiveStore } from '../state/communities';
import { BANNER_TEXT_TONE, projectionBanner } from '../lib/projectionBanner';
import { minutesAgo } from '../lib/minutesAgo';

const shortActor = (keyId: string) => (keyId.length > 12 ? `${keyId.slice(0, 12)}…` : keyId);

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
   * **판정은 `lib/projectionBanner` 하나가 한다** — 같은 사실을 위쪽 띠
   * (`ProjectionBanner`)도 말하기 때문이다(#488 A3-a). 두 자리가 각자 판정하면
   * 반드시 갈라진다.
   *
   * 문서가 오류를 사이드바에서 띠로 옮기라고 했는데도 이 경고가 **여기 남는** 이유:
   * 투영이 멈춘 동안 남아 있던 리스는 지금 벌어지는 일이 아닐 수 있고, 그것을 말없이
   * '활성 작업'으로 보여 주면 화면이 오래된 사실을 지금 사실로 주장한다. 띠는 고장을
   * 말하고, 이 줄은 **이 목록을 믿을 수 없다**를 말한다 — 다른 두 사실이다.
   */
  const banner = projectionBanner({
    status: projectionStatus,
    error: projectionStatusError,
    minutesAgo,
  });

  return (
    <div>
      <div className="px-2 pb-1 text-[11px] uppercase tracking-wide text-fg-subtle">Active work</div>
      {/*
        **띠가 말하는 것을 여기서 되풀이하지 않는다**(#489 의 결함). `projectionBanner`
        가 `strip` 을 내는데 이 자리가 그 값을 안 봐서, 위쪽 띠와 사이드바가 **같은
        문구를 두 번** 말하고 있었다(실측 2026-09-07, 사용자가 화면에서 발견).

        그렇다고 지울 수도 없다 — 두 자리가 말해야 하는 것이 **다른 사실**이기 때문이다:

          띠   → "투영이 고장났다"        (사정 자체 · 고치는 문이 붙는다)
          여기 → "이 목록을 믿을 수 없다"  (그 고장이 **이 목록에** 뜻하는 것)

        투영이 멈춘 동안 남아 있던 리스는 지금 벌어지는 일이 아닐 수 있고, 그것을 말없이
        '활성 작업'으로 보여 주면 화면이 오래된 사실을 지금 사실로 주장한다.

        그래서 **문구를 가른다**(`listNote`). 다만 사정끼리도 갈라야 한다 — `#267` 이
        "꺼짐·멈춤·정상+빈 목록이 서로 다른 문구여야 한다"를 회귀선으로 못 박았고,
        여기서 한 문구로 뭉치면 화면이 셋을 구별하지 못한다.
      */}
      {banner && (
        <div data-testid={banner.testid} className="space-y-0.5 px-2 pb-1">
          <div className={`text-xs ${BANNER_TEXT_TONE[banner.tone]}`}>
            {banner.listNote}
          </div>
          {!banner.strip && banner.detail && (
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
