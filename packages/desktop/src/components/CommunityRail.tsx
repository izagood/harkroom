import { useStore } from 'zustand';
import { communityLabel, useCommunityRegistry, type CommunityEntry } from '../state/communities';
import { switchCommunity } from '../state/controller';
import { TOP_BAR_H } from '../lib/platform';
import { useT } from '../i18n/useT';

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
  const t = useT();
  const entries = useCommunityRegistry((r) => r.entries);
  const activeId = useCommunityRegistry((r) => r.activeId);
  // 하나뿐이면 오늘 화면과 같다 — 요소를 남기지 않는다(폭 0 인 껍데기도 두지 않는다).
  if (entries.length < 2) return null;

  return (
    <nav
      data-testid="community-rail"
      aria-label={t('rail.community.label')}
      /*
        **폭이 56px 에서 72px 이 됐고 면이 `surface-switcher` 다.**
        폭: 이 레일이 서면 **이것이 창의 첫 열**이라 macOS 신호등이 여기 놓인다. 신호등 3개는
        창 왼쪽에서 58px 까지 차지하는데 56px 레일에서는 맨 오른쪽 단추가 경계선을 아예
        넘었다 — `Rail` 이 같은 이유로 72px 이 됐고(그 파일의 `RAIL_W` 에 잰 값이 있다)
        나란히 서는 두 레일이 신호등에 대해 다른 답을 가질 이유가 없다.
        면: 전환기·레일·사이드바가 전부 `surface-sunken` 한 값이어서 세 기둥이 한 덩어리로
        보였다(#5). 가장 왼쪽이 가장 가라앉는다 — 계단은 `index.css` 가 정한다.
      */
      className="flex w-[72px] shrink-0 flex-col items-center gap-2 border-r border-border bg-surface-switcher pb-2"
    >
      {/*
        타이틀바 띠 — `Rail` 의 그것과 **같은 이유이고 같은 세 클래스**다(#4). 이 레일이
        서면 창 맨 위 한 줄의 첫 조각이 여기이므로, 여기가 띠를 안 그리면 한 줄이 두 번째
        열에서 시작하는 것처럼 보인다. 신호등 자리도 이 띠가 진다(옛 `pt-8` 이 하던 일).
      */}
      <div
        data-testid="community-rail-titlebar"
        data-tauri-drag-region
        className={`w-full shrink-0 border-b border-border bg-titlebar ${TOP_BAR_H}`}
      />
      {/* 타일이 좌우 경계에 붙지 않게 여백을 준다(#3) — `Rail` 의 `RAIL_GUTTER` 와 같은 값이다. */}
      <div className="flex w-full flex-col items-center gap-2 px-2">
        {entries.map((entry) => (
          <CommunityTile key={entry.id} entry={entry} active={entry.id === activeId} />
        ))}
      </div>
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
  const t = useT();
  const connected = useStore(entry.store, (s) => s.connected);
  const label = communityLabel(entry);
  // 이니셜은 **코드 포인트 단위**로 자른다. `label[0]` 은 이모지·일부 문자를 반쪽만 잘라
  // 깨진 글자를 그린다.
  const initial = Array.from(label)[0]?.toUpperCase() ?? '?';

  return (
    <button
      type="button"
      data-testid={`community-tile-${entry.id}`}
      /* 이름과 연결 상태를 잇는 방식이 언어의 것이라 **사전이 문장을 진다** — 코드가
         `—` 를 붙이면 그 자리가 한국어의 어순으로 굳는다. `Rail` 의 마크 타일도 같은
         키를 본다: 같은 문장을 두 파일이 따로 적으면 한쪽만 고쳐진다. */
      aria-label={t('rail.community.tile', {
        name: label,
        state: t(connected ? 'rail.community.connected' : 'rail.community.disconnected'),
      })}
      aria-current={active ? 'true' : undefined}
      title={label}
      onClick={() => {
        // 전환 자체는 동기로 끝난다(레지스트리). 이 프로미스는 보관본의 `active` 를 옮기는
        // 일이고, 그 실패는 `sessionStore.save` 가 자기 자리에서 사람에게 말한다(#212).
        void switchCommunity(entry.id);
      }}
      // `text-sm` 은 4단이 아니라 **h-10 원에 묶인 머리글자**다(아래 `{initial}` 하나가
      // 내용 전부다) — `Identity.tsx` 의 아바타 머리글자와 같은 예외이고 크기가 원의
      // 지름에서 따라 나온다. `Rail.tsx` 의 h-9 타일이 한 단 아래인 것도 그 규칙이다.
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
          className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-surface-switcher bg-danger"
        />
      )}
    </button>
  );
}
