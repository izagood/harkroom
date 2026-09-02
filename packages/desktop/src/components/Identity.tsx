import type { AccountView } from '@murmur/shared';

/**
 * 계정의 아이덴티티 표현. **이 컴포넌트가 유일한 경로다.**
 *
 * 같은 `agent` 필 마크업이 컴포저(멘션 후보)와 메시지(작성자 옆) 두 곳에 중복돼 있었다 —
 * 이 저장소에서 반복되는 결함 형태다(하나의 사실이 두 곳에 유지된다). `#159`(아바타
 * 업로드)와 `#161`(채팅 거터 아바타)도 각자 그리지 말고 여기를 통과해야 한다. 실제
 * 이미지가 들어올 때 캐시가 필요해지는데, 그때도 **여기 한 곳**에 들어간다.
 *
 * 지금은 스키마에 아바타 필드가 없어 **결정론적 생성 표현**이다(#146 이 그 스코프를 골랐다).
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
    // 접근성 이름을 **시각적으로 숨긴 텍스트**로 준다. 이모지만 두면 스크린리더가 "로봇
    // 이모지"를 읽고 이전에 있던 `agent` 정보가 사라진다. `role="img"` + `aria-label` 도
    // 방법이지만 **질의 표면을 전역으로 바꾼다** — 이 저장소에는 `queryByRole('img')` 로
    // "SVG 미리보기가 없다"를 확인하는 보안 테스트가 있고, 장식 배지가 그것을 오염시킨다.
    return (
      <span className={`inline-flex items-center rounded bg-indigo-100 px-1 text-[10px] text-indigo-700 ${className}`}>
        <span aria-hidden="true">🤖</span>
        <span className="sr-only">에이전트</span>
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
