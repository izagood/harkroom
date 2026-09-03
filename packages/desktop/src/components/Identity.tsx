import { useEffect, useState } from 'react';
import { useAppStore } from '../state/appStore';
import type { AccountStatus, AccountView, HandleGroupRow } from '@murmur/shared';
import { getController } from '../state/controller';

/**
 * 계정의 아이덴티티 표현. **이 컴포넌트가 유일한 경로다.**
 *
 * 같은 `agent` 필 마크업이 컴포저(멘션 후보)와 메시지(작성자 옆) 두 곳에 중복돼 있었다 —
 * 이 저장소에서 반복되는 결함 형태다(하나의 사실이 두 곳에 유지된다). `#159`(아바타
 * 업로드)와 `#161`(채팅 거터 아바타)도 각자 그리지 말고 여기를 통과해야 한다. 실제
 * 이미지가 들어올 때 캐시가 필요해지는데, 그때도 **여기 한 곳**에 들어간다.
 *
 * #159 로 실제 사진이 들어왔다. 사진이 있으면 사진, 없으면 **기존 폴백 그대로**(이니셜·색,
 * 에이전트 글리프, 모르는 계정의 물음표)다 — 폴백은 대다수 계정이 여전히 쓰는 경로이고,
 * 사진을 얹으면서 그것을 갈아엎으면 아무 사진도 없는 워크스페이스가 통째로 망가진다.
 *
 * #181 에이전트 소유자 표시도 여기서 한다 — ownerAccountId 가 있으면 소유자 계정을
 * 계정 디렉터리에서 찾아 표시한다. 소유자가 없거나 삭제된 계정이면 아무것도 안 보인다.
 *
 * #277 에이전트 메시지의 소유자 @핸들이 아바타 거터를 넘치는 문제를 고친다. **한
 * 컴포넌트가 두 자리를 겸하다 한쪽에서 넘쳤다** — 그래서 자리를 prop 으로 명시한다:
 * - `avatar`: 거터 자리(메시지 행 왼쪽 고정폭 열, 스레드 참여자 띠, 프로필 사진 칸).
 *   모든 kind 에서 정사각 상자 하나다. 사람은 **지금의 둥근 아바타 그대로**(이 variant
 *   에서 사람 쪽 마크업은 한 글자도 바뀌지 않는다 — 넘친 것은 에이전트 쪽이었다),
 *   에이전트는 봇 글리프만(소유자 핸들·가운뎃점 없음). `overflow-hidden`, `flex-wrap` 없음.
 * - `badge`: 이름 옆 자리(메시지 이름줄, 컴포저 멘션 후보, 디렉터리 행). 지금의 인라인
 *   배지 그대로 — `#181` 이 소유자를 여기에 넣은 결정은 유효하다. **자리가 잘못됐던
 *   것이지 표시가 잘못된 게 아니다.** 기본값을 `badge` 로 두는 이유도 이것이다:
 *   새 호출자가 variant 를 잊으면 정보가 사라지는 쪽이 아니라 남는 쪽으로 떨어진다.
 *
 * 크기는 호출자가 `className` 으로 준다(`h-8 w-8` 등). 그래서 두 kind 의 기본 상자
 * 크기를 `h-5 w-5` 로 **같게** 둔다 — `h-full` 로 부모에 기대면 크기를 주지 않는
 * 부모(스레드 참여자 띠의 `ring` 래퍼) 아래에서 에이전트만 사람과 다른 크기로 그려진다.
 */
type IdentityVariant = 'avatar' | 'badge';

interface IdentityProps {
  /** 계정 디렉터리에서 못 찾은 경우를 위해 undefined 를 받는다 — 아래 처리 참고. */
  account: AccountView | undefined;
  className?: string;
  /** 거터(avatar)인지 이름 옆(badge) 자리인지 명시. 기본값은 badge. */
  variant?: IdentityVariant;
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

/**
 * 아바타 blob 캐시. **`Identity` 안에 있는 것이 요점이다** — 아바타는 메시지 목록·멘션
 * 후보·사이드바에 동시에 수십 번 걸리므로, 컴포넌트마다 따로 받으면 같은 사진을 화면당
 * 수십 번 내려받는다(`Attachments.tsx` 의 컴포넌트별 fetch 가 그 모양이다).
 *
 * 키는 계정 id 가 아니라 **첨부 id** 다. 아바타를 바꾸면 업로드가 새로 생겨 id 가 바뀌므로
 * 캐시가 저절로 무효화된다 — 따로 비우는 코드를 두지 않아도 된다.
 *
 * **revoke 하지 않는다.** 언마운트마다 revoke 하면 같은 URL 을 쓰는 다른 자리의 `<img>`
 * 가 그 순간 깨진다. 캐시는 아바타를 건 계정 수만큼만 자란다.
 */
const avatarUrls = new Map<string, string>();
/** 같은 아바타를 동시에 여러 곳에서 요청해도 왕복은 한 번이다. */
const avatarLoads = new Map<string, Promise<string | null>>();

/** 테스트가 세션 사이에 캐시를 비운다 — 앱에서는 부르지 않는다. */
export function resetAvatarCache(): void {
  avatarUrls.clear();
  avatarLoads.clear();
}

function useAvatarUrl(accountId: string | null, attachmentId: string | null): string | null {
  const [url, setUrl] = useState<string | null>(
    () => (attachmentId ? avatarUrls.get(attachmentId) ?? null : null),
  );

  useEffect(() => {
    if (!accountId || !attachmentId) { setUrl(null); return; }
    const hit = avatarUrls.get(attachmentId);
    if (hit) { setUrl(hit); return; }

    let alive = true;
    let load = avatarLoads.get(attachmentId);
    if (!load) {
      load = getController().fetchAvatar(accountId).then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        avatarUrls.set(attachmentId, objectUrl);
        return objectUrl;
      }).catch(() => {
        // 못 받으면 폴백으로 남는다. 실패를 캐시에 남기면 다시 시도할 방법이 없다.
        avatarLoads.delete(attachmentId);
        return null;
      });
      avatarLoads.set(attachmentId, load);
    }
    void load.then((got) => { if (alive) setUrl(got); });
    return () => { alive = false; };
  }, [accountId, attachmentId]);

  return url;
}

export function Identity({ account, className = '', variant = 'badge' }: IdentityProps) {
  // 에이전트에게만 사진을 받지 않는다 — 에이전트는 스스로 올릴 수단이 없고(#159 범위 밖),
  // 그 자리는 글리프가 지킨다. 훅은 조건부로 부를 수 없으므로 인자로 걸러 낸다.
  const avatarUrl = useAvatarUrl(
    account && account.kind === 'human' ? account.id : null,
    account && account.kind === 'human' ? account.avatarAttachmentId : null,
  );

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
    // #277: avatar variant 는 거터 자리 — 봇 글리프만, 소유자 핸들·가운뎃점 없음.
    // 상자 크기·모양은 사람 쪽(아래)과 같은 `h-5 w-5 rounded-full` 이다. 한 열에 사람과
    // 에이전트가 섞여 서는 자리(거터·참여자 띠)라 둘이 다른 크기면 열이 들쭉날쭉해진다.
    // `overflow-hidden` 이 이 자리의 계약이다 — 무엇이 들어와도 상자를 넘지 않는다.
    if (variant === 'avatar') {
      return (
        <span
          className={`inline-flex h-5 w-5 items-center justify-center overflow-hidden rounded-full text-[10px] ${className}`}
        >
          <span aria-hidden="true">🤖</span>
          <span className="sr-only">에이전트</span>
        </span>
      );
    }

    // badge variant (기본값): 이름 옆 자리 — 지금의 인라인 배지 그대로.
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

  // 사람 계정. **variant 를 보지 않는다** — 사람은 두 자리에서 이미 같은 둥근 아바타
  // 하나였고 넘친 적이 없다. #277 의 결함은 에이전트 배지가 거터에 들어간 것이므로,
  // 여기에 variant 분기를 넣으면 고칠 것 없는 자리를 바꿔 `rounded-full` 이 `rounded` 로
  // 갈리는 식의 무관한 회귀만 생긴다. `overflow-hidden` 도 두 자리 모두에서 필요하다 —
  // 사진(#159)은 badge 자리에도 걸리고, 상자를 넘지 않아야 하는 것은 자리와 무관하다.
  return (
    <span
      className={`inline-flex h-5 w-5 items-center justify-center overflow-hidden rounded-full text-[10px] font-semibold text-white ${avatarUrl ? 'bg-zinc-200' : handleColor(account.handle)} ${className}`}
    >
      {avatarUrl ? (
        // `alt` 를 **비운다**. 접근성 이름은 아래 sr-only 가 이미 내고 있고, 사진에 핸들을
        // 또 넣으면 같은 이름이 두 번 읽힌다. 사진은 이름을 바꾸지 않는다 — 표현만 바꾼다.
        // src 는 blob 이다: 라우트를 직접 가리키면 헤더를 붙일 수 없어 토큰이 URL 로 샌다.
        <img data-testid="identity-avatar" src={avatarUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        <span aria-hidden="true">{account.handle.charAt(0).toUpperCase()}</span>
      )}
      <span className="sr-only">{account.handle}</span>
    </span>
  );
}

/**
 * 핸들 집합의 표시(#285). `Identity` 와 **같은 자리·같은 크기의 인라인 배지**다.
 *
 * 여기 두는 이유는 위 `Identity` 주석과 같다: 같은 마크업이 두 곳에 살면 한쪽만 바뀐다.
 * 집합은 계정이 아니라 `Identity` 의 인자를 받을 수 없으므로 형제 컴포넌트로 둔다
 * (`StatusMark` 가 같은 이유로 여기 있다).
 *
 * **구성원 수를 함께 보인다.** 이름만 보이면 `@release` 가 한 사람인지 스무 사람인지
 * 모르는 채로 부르게 된다 — 부르기 직전이 그것을 알아야 하는 유일한 순간이다. 수는
 * 서버가 목록에 실어 준다(`HandleGroupRow.memberCount`).
 *
 * 색을 에이전트 배지(indigo)와 다르게 둔다 — 사람·에이전트·집합이 한 목록에 섞여 서므로
 * 셋이 서로 다른 것으로 읽혀야 한다.
 */
export function GroupBadge({ group, className = '' }: { group: HandleGroupRow; className?: string }) {
  return (
    <span
      data-testid={`group-badge-${group.handle}`}
      className={`inline-flex items-center gap-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800 ${className}`}
    >
      <span aria-hidden="true">👥</span>
      <span className="sr-only">집합</span>
      <span>{group.memberCount}명</span>
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
