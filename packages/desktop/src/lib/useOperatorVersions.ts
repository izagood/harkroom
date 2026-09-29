import { useEffect, useState } from 'react';
import { useActiveStore, useCommunityRegistry } from '../state/communities';
import { getController } from '../state/controller';
import { operatorVersionMap, type OperatorVersions } from './runnerVersions';

/**
 * 러너 버전 칩의 **기준** — 활성 커뮤니티의 오퍼레이터별 버전(`GET /operators` 의 `version`).
 *
 * 러너는 오퍼레이터가 띄우고 오퍼레이터가 자기 버전을 심으므로, "이 러너가 뒤처졌나"의 기준은
 * 보는 앱이 아니라 그 오퍼레이터다(`runnerVersions.ts` 머리말). 판정을 읽는 화면 셋(격자 칩·
 * 설정의 띠·프로필)이 **이 훅 하나**로 기준을 얻는다 — 제각각 읽으면 셋이 다른 기준을 든다.
 *
 * `operator.changed` 를 받을 때마다(`operatorsRevision`) 다시 읽는다: 오퍼레이터가 갱신돼 다시
 * 붙으면 버전이 바뀌고, 칩도 따라 바뀌어야 한다. 커뮤니티를 바꾸면 처음부터 다시 읽는다 — 오퍼레이터
 * id 는 커뮤니티마다 다르다.
 *
 * `null` 은 아직 못 읽었거나 못 읽었다 — 판정은 그때 **아무것도 뒤처졌다고 하지 않는다**.
 */
export function useOperatorVersions(enabled = true): OperatorVersions | null {
  const communityId = useCommunityRegistry((r) => r.activeId);
  const revision = useActiveStore((s) => s.operatorsRevision);
  const [versions, setVersions] = useState<{ communityId: string; map: OperatorVersions } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    // 프로미스 안에서 부른다 — 표면이 없거나 던지는 것도 "못 읽었다"로 접힌다.
    void Promise.resolve()
      .then(() => getController().operators())
      .then((list) => { if (alive) setVersions({ communityId, map: operatorVersionMap(list) }); })
      .catch(() => { if (alive) setVersions(null); });
    return () => { alive = false; };
  }, [enabled, communityId, revision]);

  // 다른 커뮤니티에서 읽은 값은 기준이 아니다(전환 직후 새 목록이 오기 전).
  return enabled && versions?.communityId === communityId ? versions.map : null;
}
