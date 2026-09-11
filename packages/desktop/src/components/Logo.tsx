/**
 * murmur 공식 로고(#191). 진폭 막대 7 개, 가운데 막대만 강조색이다.
 *
 * 인라인 SVG 로 두는 이유: `currentColor` 가 상위 요소의 색을 따라가야 하는데
 * `<img src="logo.svg">` 로 넣으면 문서 밖 리소스가 되어 상속이 끊긴다.
 *
 * 이슈 원본 SVG 에 있던 `<style>` 의 `prefers-color-scheme` 블록은 일부러 뺐다 —
 * 인라인 SVG 의 `<style>` 은 문서 전역에 적용돼 페이지의 다른 svg 까지 물들인다.
 * 대신 색은 감싸는 요소가 정하고 여기서는 `currentColor` 만 따른다.
 */
export function Logo({
  size = 128,
  className,
  decorative = false,
}: {
  size?: number;
  className?: string;
  /**
   * 옆에 텍스트 `murmur` 가 함께 있는 자리에서는 true 로 둔다. 같은 이름이 둘이면
   * 스크린리더가 같은 것을 두 번 읽는다.
   */
  decorative?: boolean;
}) {
  const a11y = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': 'harkroom' } as const);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 128 128"
      width={size}
      height={size}
      className={className}
      data-testid="murmur-logo"
      {...a11y}
    >
      {!decorative && <title>harkroom</title>}
      <path d="M20 52.0 V 76.0" stroke="currentColor" strokeWidth="9" strokeLinecap="round" />
      <path d="M35 42.0 V 86.0" stroke="currentColor" strokeWidth="9" strokeLinecap="round" />
      <path d="M50 31.0 V 97.0" stroke="currentColor" strokeWidth="9" strokeLinecap="round" />
      {/*
        가운데 막대의 색은 **토큰이다**(실측 2026-09-08, 사용자가 화면에서 지적).
        `#E8613C` 를 못 박아 두면 나머지 6 개는 `currentColor` 로 뒤집히는데 이 막대만
        라이트 값으로 남아, 다크에서 "로고 색이 안 바뀐다" 로 보인다 — 다크의
        `--app-accent-brand` 는 `#ff7b54` 로 이미 다른 값이다(`index.css`).
        `<img>` 로 쓰이는 사본(`public/logo.svg`)은 문서 밖 리소스여서 이 변수를 못 보므로
        거기서는 `prefers-color-scheme` 로 같은 두 값을 적어 둔다 — 둘을 함께 고쳐라.
        폴백을 남기는 이유: 이 컴포넌트가 `index.css` 없이 렌더되는 자리(테스트·스토리)에서
        변수가 빈 값이면 획이 사라진다.
      */}
      <path
        d="M65 18.0 V 110.0"
        stroke="var(--color-accent-brand, #E8613C)"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <path d="M80 33.0 V 95.0" stroke="currentColor" strokeWidth="9" strokeLinecap="round" />
      <path d="M95 45.0 V 83.0" stroke="currentColor" strokeWidth="9" strokeLinecap="round" />
      <path d="M110 53.0 V 75.0" stroke="currentColor" strokeWidth="9" strokeLinecap="round" />
    </svg>
  );
}
