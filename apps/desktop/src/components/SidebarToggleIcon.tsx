/**
 * 사이드바 접기·펼치기 아이콘 — **한 모양으로 통일한다**(실측 2026-09-07).
 *
 * 전에는 접기가 `←`, 펼치기가 `☰` 로 **서로 다른 글리프**였다. 같은 하나를 여닫는
 * 두 버튼이 다르게 생기면 사람이 둘을 다른 기능으로 읽는다 — 특히 `←` 는 앱 안에서
 * 이미 **뒤로 가기**가 쓰는 글리프라(`Workspace` 헤더에 나란히 있다) 같은 줄에서
 * 두 뜻으로 쓰였다.
 *
 * 패널 모양을 그린다: 바깥 틀이 창이고 왼쪽 칸이 사이드바다. 무엇을 여닫는지가
 * 그림 자체로 보이므로 방향 화살표가 필요 없다 — 화살표를 쓰면 "지금 접히나 펴지나"를
 * 상태에 따라 뒤집어야 하고, 그때부터 아이콘이 상태를 두 벌로 말한다.
 *
 * `aria-hidden` 인 이유: 버튼이 `aria-label` 로 이미 말한다. 그림에 이름을 또 주면
 * 스크린리더가 같은 것을 두 번 읽는다.
 */
export function SidebarToggleIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={`h-4 w-4 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    >
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <line x1="6.25" y1="2.75" x2="6.25" y2="13.25" />
    </svg>
  );
}
