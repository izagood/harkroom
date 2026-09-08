import { useMemo } from 'react';
import { useActiveStore } from '../state/communities';
import { BANNER_TEXT_TONE, projectionBanner } from '../lib/projectionBanner';
import { useAgo } from '../i18n/useT';

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
 *
 * **그릴 내용이 없으면 이 영역 전체가 사라진다**(`hasContent`, 실측 v0.1.52). 내용
 * 셋이 모두 조건부인데 제목만 무조건이면 제목 혼자 남는다 — 그것이 사용자가 화면에서
 * 본 빈 칸이었다. 위 네 사정은 그대로 구별된다: 제목이 사라지는 유일한 창에서 그
 * 사정은 화면 위쪽 띠가 말하고 있고, 띠가 세우지 않는 사정은 여기 남는다.
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
    ago: useAgo(),
  });

  /**
   * **그릴 내용이 하나라도 있는가**(문서 3 · 실측 v0.1.52).
   *
   * 사용자가 앱에서 발견한 것: 홈 패널 하단에 `ACTIVE WORK` 라벨만 있고 **그 아래가
   * 완전히 비어 있었다.** 아래 내용 셋은 전부 조건부인데 제목에는 조건이 하나도 없어서,
   * 셋이 모두 거짓인 창에서 제목만 남았다.
   *
   * 문서 3 이 그 자리를 이렇게 정했다 — *"설정 오류는 띠로 나가고, 그 구역은 그냥
   * 없어진다."* 「없어진다」는 **제목까지** 없어지는 것이다. 빈 제목은 없어진 것이
   * 아니라 이름만 남은 빈 칸이다.
   *
   * 셋을 따로 세면 판정이 넷이 되어 갈라진다. 아래 내용의 조건을 그대로 합집합으로
   * 묶으면 비는 창은 **하나**다: 띠가 이미 말하는 고장(`strip: true`)인데 남은 리스가
   * 없을 때. 그때만 목록 줄도, "없다"도, 리스도 그리지 않는다.
   *
   * **`projectionBanner()` 의 판정과 `strip` 을 그대로 쓴다.** 새 판정을 만들면 제목이
   * 보이는 조건과 내용이 보이는 조건이 갈라지고, 그것이 이 결함의 형태였다.
   */
  const hasContent = byRepo.length > 0 || banner === null || !banner.strip;

  /**
   * **제목을 감추는 것이 사정을 지우는 것은 아니다.** 제목이 사라지는 유일한 창
   * (`strip: true` + 빈 목록)에서 그 사정은 이미 화면 위쪽 띠가 말하고 있다 — 꺼진 것,
   * 멈춘 것, 못 읽은 것 셋이 거기서 서로 다른 문구로 나온다. 띠가 세우지 않는
   * '확인하는 중'(`strip: false`)은 여기가 유일한 자리라 제목과 함께 남는다.
   */
  if (!hasContent) return null;

  return (
    <div>
      <div className="px-2 pb-1 text-meta uppercase tracking-wide text-fg-subtle">Active work</div>
      {/*
        **고장은 여기서 말하지 않는다**(문서 4 · 실측 2026-09-07).

        #489 에서 고장을 화면 위쪽 띠로 옮기면서 이 자리에도 한 줄을 남겼다 — 띠는
        "고장났다"를, 이 줄은 "이 목록을 믿을 수 없다"를 말하니 **다른 사실**이라는
        판단이었다. 문장까지 갈라 뒀다.

        **그래도 화면에서는 중복이었다.** 사용자가 앱에서 확인한 것: 띠와 왼쪽 줄이
        같은 주의색으로 나란히 서서, 문장이 다르다는 것은 읽어야 알 수 있고 눈에는
        **같은 경고 둘**로 보인다. 문서 4 가 같은 결론을 적었다 — *"설정 오류는 띠로
        나가고, 그 구역은 그냥 없어진다."*

        `projectionBanner()` 는 그대로 쓴다. 지우는 것은 **띠가 이미 말하는 사정**
        (`strip: true`)뿐이고, 띠가 세우지 않는 '확인하는 중'(`strip: false`)은 여기가
        **유일한 자리**라 남긴다 — 여기서도 지우면 그 사정이 화면에서 사라진다.
      */}
      {/*
        **남은 리스가 있을 때는 예외다.** 이 파일의 존재 이유가 그것이다: 투영이 멈춘
        동안 남아 있던 리스를 **말없이 '활성 작업'으로 보여 주면** 화면이 오래된 사실을
        지금 사실로 주장한다. 그래서 목록이 비어 있지 않은 동안에는 짧은 한 줄을 남긴다 —
        띠는 "투영이 고장났다"를 말할 뿐, **이 목록이 낡았다**는 말은 하지 않는다.

        목록이 비어 있으면 그 줄도 필요 없다. 주장할 데이터가 없으니 띠 하나로 충분하고,
        그때가 사용자가 본 중복이었다.
      */}
      {banner && (!banner.strip || byRepo.length > 0) && (
        <div data-testid={banner.testid} className="space-y-0.5 px-2 pb-1">
          {/* 이 파일은 사이드바 안이고, **사이드바의 단은 아랫단 11px** 이다 —
              `Sidebar.tsx` 가 오류·안내·멤버 이름·구획 라벨을 이미 전부 11px 로 통일해
              뒀다(그 파일의 10px 27곳을 11px 로 올린 작업). 여기만 본문단으로 올리면
              같은 열에 두 단이 서고, 이 줄이 사이드바에서 혼자 크게 보인다. */}
          <div className={`text-meta ${BANNER_TEXT_TONE[banner.tone]}`}>{banner.listNote}</div>
        </div>
      )}
      {/* "No active work" 는 **상태를 읽었고 정상일 때만** 쓴다. 그 밖의 경우는 위
          배너가 왜 비어 있는지 이미 말했고, 거기에 "없다"를 덧붙이면 읽지도 못한
          것을 없다고 단정하는 셈이다. */}
      {byRepo.length === 0 && banner === null && (
        <div className="px-2 text-meta text-fg-muted">No active work</div>
      )}
      {byRepo.map(([repo, rows]) => (
        <div key={repo} className="px-2 pb-1">
          <div className="text-meta font-semibold text-fg-muted">{repo}</div>
          {rows.map((l) => (
            <div key={`${l.path}:${l.actorKeyId}`} className="truncate text-meta text-fg-subtle">
              {l.path} — {shortActor(l.actorKeyId)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
