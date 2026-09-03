import { useAppStore } from '../state/appStore';
import type { AccountStatus, AccountView } from '@murmur/shared';

/**
 * 계정의 아이덴티티 표현. **이 컴포넌트가 유일한 경로다.**
 *
 * 같은 `agent` 필 마크업이 컴포저(멘션 후보)와 메시지(작성자 옆) 두 곳에 중복돼 있었다 —
 * 이 저장소에서 반복되는 결함 형태다(하나의 사실이 두 곳에 유지된다). `#159`(아바타
 * 업로드)와 `#161`(채팅 거터 아바타)도 각자 그리지 말고 여기를 통과해야 한다. 실제
 * 이미지가 들어올 때 캐시가 필요해지는데, 그때도 **여기 한 곳**에 들어간다.
 *
 * 지금은 스키마에 아바타 필드가 없어 **결정론적 생성 표현**이다(#146 이 그 스코프를 골랐다).
 *
 * #181 에이전트 소유자 표시도 여기서 한다 — ownerAccountId 가 있으면 소유자 계정을
 * 계정 디렉터리에서 찾아 표시한다. 소유자가 없거나 삭제된 계정이면 아무것도 안 보인다.
 */
interface IdentityProps {
  /** 계정 디렉터리에서 못 찾은 경우를 위해 undefined 를 받는다 — 아래 처리 참고. */
  account: AccountView | undefined;
  className?: string;
}

/** 핸들에서 결정론적으로 색을 고른다. 순수 함수라 캐시가 필요 없다. */
function handleColor(handle: string): string {
  let hash = 0;
  for (let i = 0; i < handle.length; i += 1) {
    hash = (hash << 5) - hash + handle.charCodeAt(i);
    hash |= 0;
  }
  // 흰 글자와의 대비를 위해 500 계열을 쓴다 — 200 계열은 흰 글자가 거의 안 읽힌다.
  const colors = [
    'bg-red-500', 'bg-orange-500', 'bg-amber-600', 'bg-lime-600',
    'bg-emerald-600', 'bg-teal-600', 'bg-cyan-600', 'bg-sky-600',
    'bg-blue-500', 'bg-violet-500', 'bg-fuchsia-500', 'bg-rose-500',
  ];
  return colors[Math.abs(hash) % colors.length]!;
}

export function Identity({ account, className = '' }: IdentityProps) {
  // #181 소유자는 계정 디렉터리에서 푼다. `getState()` 가 아니라 **구독**이어야 한다 —
  // 디렉터리는 로그인 뒤에 채워지고 계정 변경 이벤트로 갱신되므로, 스냅샷으로 읽으면
  // 먼저 그려진 메시지의 소유자가 영영 안 붙는다. 훅은 조건 밖 최상단에서만 부를 수 있다.
  const accounts = useAppStore((s) => s.accounts);

  // **"없다"와 "모른다"는 다르다.** 계정 디렉터리에 없는 id 는 후자이고, 아무것도
  // 그리지 않으면 "에이전트가 아니다"로 읽힌다 — docs/design.md 4절의 거울상이다.
  if (!account) {
    return (
      <span
        className={`inline-flex h-5 w-5 items-center justify-center rounded-full bg-zinc-400 text-[10px] font-semibold text-white ${className}`}
      >
        <span aria-hidden="true">?</span>
        <span className="sr-only">알 수 없는 계정</span>
      </span>
    );
  }

  if (account.kind === 'agent') {
    // #181 소유자 표시. `null` 이 정상 상태다 — `008_agent_runner.sql` 이 backfill 없이
    // 컬럼을 더했고 "추측 소유자는 소유자가 아니다"가 그 이유였다. 그래서 없을 때는
    // **아무것도 그리지 않는다**: "운영자 미상" 같은 문구를 넣으면 화면 대부분이 그
    // 문구로 채워져 아무것도 구분하지 못하고, 서버가 모르는 것을 없다고 단정하게 된다.
    // 소유자 계정이 지워졌으면 컬럼이 `on delete set null` 이라 같은 자리로 온다.
    const owner = account.ownerAccountId ? accounts[account.ownerAccountId] : undefined;

    // 접근성 이름을 **시각적으로 숨긴 텍스트**로 준다. 이모지만 두면 스크린리더가 "로봇
    // 이모지"를 읽고 이전에 있던 `agent` 정보가 사라진다. `role="img"` + `aria-label` 도
    // 방법이지만 **질의 표면을 전역으로 바꾼다** — 이 저장소에는 `queryByRole('img')` 로
    // "SVG 미리보기가 없다"를 확인하는 보안 테스트가 있고, 장식 배지가 그것을 오염시킨다.
    return (
      <span className={`inline-flex flex-wrap items-center gap-1 rounded bg-indigo-100 px-1 text-[10px] text-indigo-700 ${className}`}>
        <span aria-hidden="true">🤖</span>
        <span className="sr-only">에이전트</span>
        {owner && (
          <>
            {/* 가운뎃점은 장식이다 — 스크린리더에는 "소유자"라는 말이 대신 간다. */}
            <span aria-hidden="true">·</span>
            <span className="sr-only">소유자</span>
            <span title={`소유자: ${owner.displayName || owner.handle}`}>@{owner.handle}</span>
          </>
        )}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold text-white ${handleColor(account.handle)} ${className}`}
    >
      <span aria-hidden="true">{account.handle.charAt(0).toUpperCase()}</span>
      <span className="sr-only">{account.handle}</span>
    </span>
  );
}

/** 상태별 글리프와 사람이 읽는 이름. 화면과 접근성 이름이 갈리지 않게 한 표에서 낸다. */
const STATUS_MARKS: Record<AccountStatus, { glyph: string; label: string } | null> = {
  // 기본값에는 표시를 붙이지 않는다 — 모두에게 붙은 표시는 아무것도 구분하지 못하고,
  // 초록 연결 점 옆에 초록 무언가를 하나 더 두면 둘의 뜻이 섞인다.
  available: null,
  away: { glyph: '🌙', label: '자리 비움' },
  dnd: { glyph: '⛔', label: '방해 금지' },
};

/**
 * 사람이 직접 고른 상태 표시(#186). **연결 점을 대체하지 않는다** — 나란히 붙는다.
 * 둘은 다른 사실이다: 점은 소켓이 붙어 있는가(기계가 파생), 이것은 지금 말을 걸어도
 * 되는가(사람이 선언). 하나로 합치면 "연결이 끊긴 사람"과 "방해 금지인 사람"이 뭉친다.
 *
 * 에이전트에는 그리지 않는다 — 서버가 에이전트의 상태 변경을 거절하므로 그 값은 기본값일
 * 뿐이고, 그리면 사람이 고른 신호처럼 읽힌다.
 */
export function StatusMark({ account, className = '' }: {
  account: AccountView | undefined;
  className?: string;
}) {
  if (!account || account.kind !== 'human') return null;
  const mark = STATUS_MARKS[account.status];
  if (!mark) return null;
  // 문구가 있으면 접근성 이름에 함께 싣는다 — 좁은 자리에 글자를 더 밀어 넣지 않으면서도
  // 스크린리더와 툴팁에는 사람이 적은 말이 도달한다. 이스케이프는 React 가 한다.
  const name = account.statusText ? `${mark.label}: ${account.statusText}` : mark.label;
  return (
    <span
      data-testid={`status-${account.id}`}
      data-status={account.status}
      title={name}
      className={`inline-flex items-center text-[10px] leading-none ${className}`}
    >
      <span aria-hidden="true">{mark.glyph}</span>
      <span className="sr-only">{name}</span>
    </span>
  );
}
