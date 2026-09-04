import { useMemo } from 'react';
import { useStore } from 'zustand';
import { communityLabel, useCommunityRegistry, type CommunityEntry } from '../state/communities';
import { switchCommunity } from '../state/controller';
import { isMacOS } from '../lib/platform';

/**
 * 커뮤니티 전환기(#165 결정 1). 사이드바 **왼쪽**에 서는 얇은 레일이다.
 *
 * **커뮤니티가 하나면 아무것도 그리지 않는다.** 없는 것을 위해 자리를 미리 비워 두면, 서버
 * 하나만 쓰는 사람(오늘의 거의 모든 사용자)의 화면이 이유 없이 좁아진다 — 그 사람에게는
 * 전환할 대상이 없으므로 전환기는 정보가 0 인 기둥이다.
 *
 * **아바타를 쓰지 않는다.** 커뮤니티 아바타는 서버가 그것을 알아야 하는 일이고(#163 의 결정
 * (A) 는 서버 계약을 건드리지 않는다), 그래서 표시는 이름의 이니셜 타일이다.
 *
 * **`#146`·`#159` 의 아바타 컴포넌트(`Identity`)를 재사용하지 않는다.** 그것은 **계정 신원**
 * (누가 말하는가)이고 이것은 **서버 신원**(어느 커뮤니티인가)이다. 지금은 둘 다 "원 안의
 * 글자" 라 같아 보이지만, 계정 쪽은 이미 프로필 사진·상태 표식·프레즌스를 달고 있고 커뮤니티
 * 쪽은 연결 상태를 단다 — 한 컴포넌트로 묶으면 두 축의 prop 이 서로에게 무의미한 채로 쌓이고
 * 나중에 갈라질 때 두 화면이 함께 부서진다.
 */
export function CommunityRail() {
  const entries = useCommunityRegistry((r) => r.entries);
  const activeId = useCommunityRegistry((r) => r.activeId);
  /**
   * 레일이 그려지면 **레일이 창의 좌상단**이 되므로 macOS 신호등이 첫 타일을 덮는다.
   * 가로가 아니라 세로로 비운다: 레일은 신호등 3 개(78px)보다 좁아서 가로 여백으로는
   * 피할 수 없고, 사이드바의 기존 가로 여백(`MAC_TRAFFIC_LIGHT_PL`)은 그대로 두어도
   * 레일 폭만큼 오른쪽으로 밀려 있어 덮이지 않는다.
   */
  const macTrafficLightRoom = useMemo(() => isMacOS(), []);

  // 하나뿐이면 오늘 화면과 같다 — 요소를 남기지 않는다(폭 0 인 껍데기도 두지 않는다).
  if (entries.length < 2) return null;

  return (
    <nav
      data-testid="community-rail"
      aria-label="커뮤니티 전환"
      className={`flex w-14 shrink-0 flex-col items-center gap-2 border-r border-border bg-surface-sunken pb-2 ${
        macTrafficLightRoom ? 'pt-8' : 'pt-2'
      }`}
    >
      {entries.map((entry) => (
        <CommunityTile key={entry.id} entry={entry} active={entry.id === activeId} />
      ))}
    </nav>
  );
}

/**
 * 타일 하나. **연결 상태를 자기 커뮤니티의 스토어에서 직접 읽는다** — 전역 플래그 하나로
 * 합치면 "셋 중 하나가 끊겼다" 가 "끊겼다" 로 뭉쳐 나머지 둘에 대해 거짓말이 된다(#166 이
 * 커뮤니티별 `connected` 를 만든 이유이고, 이 타일이 그 요구를 받는 자리다).
 *
 * 상태를 색·점으로만 말하지 않고 **접근 가능한 이름에 넣는다**: 점 하나는 스크린리더에
 * 아무것도 아니고, 색만으로 구분하면 그 구분이 색을 못 보는 사람에게는 없는 것과 같다.
 */
function CommunityTile({ entry, active }: { entry: CommunityEntry; active: boolean }) {
  const connected = useStore(entry.store, (s) => s.connected);
  const label = communityLabel(entry);
  // 이니셜은 **코드 포인트 단위**로 자른다. `label[0]` 은 이모지·일부 문자를 반쪽만 잘라
  // 깨진 글자를 그린다.
  const initial = Array.from(label)[0]?.toUpperCase() ?? '?';

  return (
    <button
      type="button"
      data-testid={`community-tile-${entry.id}`}
      aria-label={`${label} — ${connected ? '연결됨' : '연결 끊김'}`}
      aria-current={active ? 'true' : undefined}
      title={label}
      onClick={() => {
        // 전환 자체는 동기로 끝난다(레지스트리). 이 프로미스는 보관본의 `active` 를 옮기는
        // 일이고, 그 실패는 `sessionStore.save` 가 자기 자리에서 사람에게 말한다(#212).
        void switchCommunity(entry.id);
      }}
      className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold
        ${active
          ? 'bg-accent text-fg-on-strong'
          : 'bg-surface-raised text-fg-muted hover:bg-surface-hover'}
        ${connected ? '' : 'border-2 border-danger'}`}
    >
      {initial}
      {!connected && (
        <span
          aria-hidden
          data-testid={`community-offline-${entry.id}`}
          className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-surface-sunken bg-danger"
        />
      )}
    </button>
  );
}
