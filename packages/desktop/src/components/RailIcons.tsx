import type { ReactElement } from 'react';

/**
 * 레일 네 칸의 아이콘(사용자 요청 2, 2026-09-08 — 참고 화면을 첨부해 "아이콘 형식으로" 고쳐
 * 달라고 했다).
 *
 * ## 왜 이모지를 버리는가
 *
 * 앞 판은 `🏠 💬 🤖 🔖` 였다. 그것이 **그림이 아니라 글자**라는 점이 이 자리의 문제다:
 *
 * - 폰트가 정하는 그림이라 **OS 마다 다른 그림**이 뜬다. macOS 의 🏠 는 창이 둘 달린 노란
 *   집이고 Windows 의 그것은 파란 집이다 — 레일은 이 앱의 첫 화면이라 그 편차가 브랜드로
 *   보이지 않는다. `Rail.tsx` 스스로 "홈과 에이전트는 아직 자리만 잡은 글리프"라고 적어
 *   두었다.
 * - **색을 물려받지 못한다.** 이모지는 자기 색을 들고 오므로 고른 칸(`text-fg`)과 안 고른
 *   칸(`text-fg-muted`)이 글자만 밝아지고 그림은 그대로다 — 지금 어느 칸인지가 절반만
 *   말해진다. 아래 아이콘은 `stroke="currentColor"` 라 칸의 상태를 그대로 따른다.
 * - 이모지는 크기가 글자 크기라 타이포 4단의 예외를 하나 만들어 두어야 했다
 *   (`test/typeScale.test.ts` 의 `ALLOWED`). 선 아이콘은 `width`/`height` 속성이 지름을
 *   정하므로 그 예외가 필요 없다 — 이번 판에서 그 항목을 지웠다.
 *
 * ## 왜 아이콘 라이브러리를 넣지 않는가
 *
 * 네 개를 위해 의존성을 늘리지 않는다. 이 저장소에는 이미 손으로 그린 아이콘이 둘
 * 있고(`Logo.tsx` · `SidebarToggleIcon.tsx`) 같은 관례를 따른다: 24 격자, 선 굵기 1.5,
 * `currentColor`, 끝은 둥글게.
 *
 * `aria-hidden` 이다 — 이름은 칸의 `aria-label` 이 진다(`Rail.tsx` 의 `RailButton`).
 * 그림이 이름을 또 내면 스크린리더가 칸 하나를 두 번 읽는다.
 */
function Icon({ children }: { children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** 홈 — 집. Inbox·디렉터리까지 받는 칸이라 그 자리를 가장 넓게 말하는 그림이다. */
export function HomeIcon(): ReactElement {
  return (
    <Icon>
      <path d="M4 10.5 12 4l8 6.5" />
      <path d="M6 9.8V19a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.8" />
      <path d="M10 20v-5h4v5" />
    </Icon>
  );
}

/** DM — 말풍선. 문서가 이 칸에 그려 둔 그림이 말풍선이다. */
export function DmIcon(): ReactElement {
  return (
    <Icon>
      <path d="M20 12.5c0 3.6-3.6 6.5-8 6.5-.9 0-1.8-.1-2.6-.35L5 20.5l1.2-3.2C4.8 16.1 4 14.4 4 12.5 4 8.9 7.6 6 12 6s8 2.9 8 6.5Z" />
    </Icon>
  );
}

/**
 * 에이전트 — 사람 얼굴이 아니라 **머리 위에 안테나가 달린 상자**다. 이 앱에서 에이전트는
 * 사람과 같은 자리에서 말하므로(같은 채널·같은 스레드), 사람 얼굴로 그리면 그 칸이
 * 디렉터리와 구별되지 않는다.
 */
export function AgentsIcon(): ReactElement {
  return (
    <Icon>
      <path d="M12 3v2.5" />
      <rect x="4.5" y="6.5" width="15" height="11" rx="3" />
      <path d="M9 11.5v1.5M15 11.5v1.5" />
      <path d="M8.5 20.5h7" />
    </Icon>
  );
}

/** 담아 둔 것 — 책갈피. 스스로 미뤄 둔 것이라는 뜻이 이 그림에 이미 있다. */
export function SavedIcon(): ReactElement {
  return (
    <Icon>
      <path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-3.5L6 20V5.5a1 1 0 0 1 1-1Z" />
    </Icon>
  );
}
