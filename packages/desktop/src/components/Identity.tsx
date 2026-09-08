import { useEffect, useState } from 'react';
import type { AccountStatus, AccountView, AgentTeamRow, HandleGroupRow } from '@murmur/shared';
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
 * - `badge`: 이름 옆 자리. **이제 아무것도 그리지 않는다 — 사람도, 에이전트도.**
 *   #365 가 사람 쪽에서 지운 것을 에이전트에도 적용했다: 화면은 작성자가 사람인지
 *   에이전트인지 말하지 않는다. `#181` 이 소유자를 여기 넣은 결정은 그 전제 위에 있었고,
 *   전제가 바뀌었다 — 종류·소유자·하네스는 프로필(#475)이 답한다.
 *   기본값을 `badge` 로 두는 이유가 여기서 뒤집힌다: 이제 variant 를 잊은 호출자는
 *   **지운 표시를 되살리는 쪽이 아니라 아무것도 안 그리는 쪽**으로 떨어진다.
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

/**
 * **아바타 안의 머리글자는 타이포 4단이 아니다 — 상자에 묶인 글리프다.**
 *
 * 4단(11 / 13 / 15 / 17)은 *읽는 글자*의 단이다. 아래 `avatar` 분기의 `text-[10px]` 은
 * 읽는 글자가 아니라 `h-5 w-5` 원을 채우는 그림이고, 크기가 원의 지름에서 따라 나온다.
 * 그래서 호출부도 상자와 글자를 **한 쌍으로** 넘긴다: `h-8`→`text-sm`, `h-5`→`text-[10px]`,
 * `h-4`→`text-[8px]`. `AgentGrid` 의 `face`/`faceText` 가 같은 규칙을 표로 갖고 있다.
 *
 * 이 쌍을 4단으로 끌어올리면 지름은 그대로인데 글자만 커져 원 안에서 머리글자가 가장자리에
 * 붙는다. 20px 원에 11px 글자는 줄높이 12.96px 로 넘치지는 않지만(실측), 넘치지 않는 것과
 * 원 안에서 균형이 맞는 것은 다른 문제다 — 그리고 이 자리는 사람과 에이전트가 한 열에
 * 섞여 서므로 균형이 깨지면 열 전체가 들쭉날쭉해진다(#471 이 같은 자리에서 이미 한 번
 * 났다). 단을 지키려고 그림을 망가뜨리지 않는다.
 *
 * 회귀선은 `test/typeScale.test.ts` 이고, 이 자리들을 예외로 적어 뒀다.
 *
 * ## 껍데기 span 은 전부 `relative` 다 — 장식이 아니다
 *
 * 이 컴포넌트가 이름을 내는 방식은 `sr-only` 이고, Tailwind 의 그것은 **`position:
 * absolute`** 다. 껍데기에 `relative` 가 없으면 그 스팬의 컨테이닝 블록이 **초기 컨테이닝
 * 블록(ICB)** 이 되고, 그러면 조상에 걸린 `overflow-hidden` 이 **하나도 안 듣는다** —
 * 자르는 상자는 컨테이닝 블록 사슬 위에 있을 때만 자르기 때문이다.
 *
 * 실측 2026-09-08(창 1400×578, 인박스 30줄): 인박스 줄마다 선 이 아바타의 `sr-only` 가
 * 목록 길이만큼 문서 좌표에 깔려 `documentElement.scrollHeight` 를 578 → **2450** 으로
 * 늘렸다. 그러면 문서가 스크롤 가능해지고, `scrollIntoView` 한 번에 **앱 껍데기 전체가
 * 창 위로 올라간다**(상단 바·채널 머리가 잘리고 되돌릴 스크롤바도 없다).
 *
 * 인박스가 `Overlay`(`fixed` = positioned 조상)를 벗기 전에는 그 울타리에 가려 안 보였다.
 * 사이드바·메시지 줄은 우연히 `relative` 가 있어 무사했고 — 우연에 기대지 않는다.
 * 오프셋을 주지 않으므로 그림은 한 픽셀도 바뀌지 않는다. 회귀선은
 * `test/shellScroll.test.tsx`.
 */
export function Identity({ account, className = '', variant = 'badge' }: IdentityProps) {
  // 사람과 에이전트 **둘 다** 사진을 받는다. 훅은 조건부로 부를 수 없으므로 인자로 걸러 낸다.
  //
  // 여기가 `kind === 'human'` 으로 좁혀져 있었다. 그때는 참이었지만(#159 는 사람만 올렸다)
  // Task 15-4 가 에이전트 쓰기 경로(`PUT /accounts/agents/:id/avatar`)를 열면서 거짓이
  // 되었다 — 그 커밋은 라우트·api·컨트롤러·설정 화면을 다 만들고 **읽는 자리인 여기만
  // 건드리지 않았다.** 결과는 조용한 실패다: 소유자가 사진을 올리면 서버는 200 을 주고
  // DB 도 바뀌는데 아래 에이전트 분기의 `avatarUrl` 은 영원히 null 이라 화면은 이니셜
  // 색상 그대로다. 사람에게는 "업로드가 안 먹었다"로만 보인다.
  //
  // variant 는 그대로 걸러 낸다. `badge` 자리는 이제 **아무것도** 그리지 않는다(사람은
  // #365, 에이전트는 #455) — 그리지 않는 자리에서 바이트를 받으면
  // 100 명이 선 디렉터리가 아무것도 안 보이면서 왕복 100 번을 낸다. 캐시가 있어 첨부당 한
  // 번이지만, 그 한 번도 필요 없는 왕복이다.
  const showsPhoto = account !== undefined && variant === 'avatar';
  const avatarUrl = useAvatarUrl(
    showsPhoto ? account.id : null,
    showsPhoto ? account.avatarAttachmentId : null,
  );

  // **`badge` 자리는 이제 아무것도 그리지 않는다 — 사람도, 에이전트도.**
  // #365 가 사람 쪽에서 먼저 지운 것을 에이전트에도 그대로 적용한다: 화면은 작성자가
  // 사람인지 에이전트인지 **말하지 않는다**(design doc 2, #455). 거터 아바타가 이미
  // 둘을 같은 모양으로 세우고 있는데 이름 옆에서만 🤖 와 소유자 핸들이 붙으면, 아바타로
  // 지운 구분을 배지가 도로 그린다. 종류·소유자·하네스는 프로필(#475)이 답한다.
  //
  // `!account` 보다 **먼저** 걸러 낸다. 이 자리에서는 "모르는 계정"조차 그릴 것이 없다 —
  // 물음표 원은 아바타 자리의 표시이지 이름 옆 표시가 아니다.
  //
  // variant 와 기본값은 남긴다. 지금 이 저장소에 `badge` 를 넘기는 호출자는 없지만,
  // 기본값이 "아무것도 안 그리는 쪽"이면 variant 를 잊은 새 호출자가 지운 표시를
  // 되살리는 일이 없다 — #365 가 사람 쪽에서 같은 이유로 내린 결정이다.
  if (variant === 'badge') return null;

  // **"없다"와 "모른다"는 다르다.** 계정 디렉터리에 없는 id 는 후자이고, 아무것도
  // 그리지 않으면 "에이전트가 아니다"로 읽힌다 — docs/design.md 4절의 거울상이다.
  if (!account) {
    return (
      <span
        className={`relative inline-flex h-5 w-5 items-center justify-center rounded-full bg-fg-subtle text-[10px] font-semibold text-fg-on-strong ${className}`}
      >
        <span aria-hidden="true">?</span>
        <span className="sr-only">알 수 없는 계정</span>
      </span>
    );
  }

  // **여기서 종류를 가르지 않는다.** 바로 위에 `kind === 'agent'` 분기가 있었고, 그 안의
  // 마크업은 이 아래와 한 글자도 다르지 않았다 — #465(같은 아바타)와 #575(에이전트도
  // 사진을 받는다)가 차례로 두 분기를 같은 것으로 만든 뒤, 배지가 빠지면서 마지막 차이도
  // 없어졌다. 같은 그림을 두 곳에서 유지하면 한쪽만 바뀐다(이 파일이 반복해서 겪은 결함
  // 형태다). 종류·소유자·하네스는 프로필(#475)이 답한다.
  //
  // #365 가 사람의 `badge` 를 지웠고 지금은 그 규칙이 에이전트에도 걸린다(위 조기 반환).
  // 여기 남은 것은 `avatar` 자리뿐이다.
  //
  // 이 자리에 있던 #277 의 주석은 여기에 variant 분기를 넣지 않은 근거였다: "고칠 것 없는
  // 자리를 바꿔 `rounded-full` 이 `rounded` 로 갈리는 식의 무관한 회귀만 생긴다."
  // **그 판단은 그때 기준으로 틀리지 않았다** — 사람 아바타는 32px 거터를 넘친 적이 없다.
  // 넘친 것은 에이전트 쪽 배지였고, 그 배지는 이제 없다. `rounded-full`·`overflow-hidden`
  // 은 그대로이며 #277 회귀선이 계속 지킨다.
  //
  // `overflow-hidden` 은 이 자리에도 걸려 있다 — 사진(#159)이 상자를 넘지 않아야 한다.
  return (
    <span
      className={`relative inline-flex h-5 w-5 items-center justify-center overflow-hidden rounded-full text-[10px] font-semibold text-fg-on-strong ${avatarUrl ? 'bg-surface-hover' : handleColor(account.handle)} ${className}`}
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
      className={`relative inline-flex items-center gap-1 rounded bg-warning-surface-strong px-1 text-[11px] text-warning ${className}`}
    >
      <span aria-hidden="true">👥</span>
      <span className="sr-only">집합</span>
      <span>{group.memberCount}명</span>
    </span>
  );
}

/**
 * 에이전트 팀의 표시(#172). `GroupBadge` 와 **같은 자리·같은 크기**이고, 그 형제로 여기
 * 산다 — 같은 마크업이 두 곳에 살면 한쪽만 바뀐다는 위의 이유가 그대로다.
 *
 * `GroupBadge` 에 `kind` 를 하나 더해 겸용하지 않는 이유: 두 배지의 **인자가 다르다**
 * (`HandleGroupRow.handle`·`displayName` 대 `AgentTeamRow.name`). 한 컴포넌트가 둘을
 * 받으려면 호출부가 모양을 맞춰 넘겨야 하고, 그 변환이 두 화면에 흩어진다.
 *
 * **색과 글리프를 집합과 다르게 둔다.** 계정·집합·팀이 한 목록에 섞여 서므로 셋이 서로
 * 다른 것으로 읽혀야 한다(`GroupBadge` 가 에이전트 배지와 색을 다르게 둔 것과 같은
 * 판단이다). 강조색은 쓰지 않는다 — 부를 수 있는 이름은 나를 막는 것이 아니다(규칙 04).
 *
 * **수를 함께 보인다.** 이름만 보이면 `@release` 가 하나인지 다섯인지 모르는 채로 부르게
 * 된다 — `AgentTeamRow.memberCount` 주석이 이 자리를 지목한다. 그 수는 **비활성 팀원도
 * 센다**: 명단의 크기는 운영자의 의도이고, 그 중 몇이 깨는지는 부른 뒤에 알 수 있다.
 */
export function TeamBadge({ team, className = '' }: { team: AgentTeamRow; className?: string }) {
  return (
    <span
      data-testid={`team-badge-${team.name}`}
      className={`relative inline-flex items-center gap-1 rounded bg-surface-hover px-1 text-[11px] text-fg-muted ${className}`}
    >
      <span aria-hidden="true">🤖</span>
      <span className="sr-only">팀</span>
      <span>{team.memberCount}명</span>
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
      className={`relative inline-flex items-center text-[11px] leading-none ${className}`}
    >
      <span aria-hidden="true">{mark.glyph}</span>
      <span className="sr-only">{name}</span>
    </span>
  );
}
