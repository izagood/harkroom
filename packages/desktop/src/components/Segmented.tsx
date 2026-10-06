/**
 * 몇 개 중 하나 고르기(라디오 묶음) — 「읽기만 / 읽기+쓰기」·만료·「사람 글 턴만」처럼 짧은 선택지를 버튼 줄로 보인다
 * (#1144 designer n1). 접근성은 `radiogroup`/`radio`+`aria-checked` 그대로다 — 시험이 이름으로 찾는다.
 */
export interface SegmentedOption<T extends string> { value: T; label: string; disabled?: boolean; onPick?: () => void }

export function Segmented<T extends string>({ label, value, options, onChange, disabled, showLabel = true, className = '', children, testId }: {
  label: string;
  value: T | null;
  options: readonly SegmentedOption<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
  /** 왼쪽에 라벨 글자를 보일지(접근 이름은 언제나 `label`). */
  showLabel?: boolean;
  className?: string;
  /** 버튼 줄 뒤에 붙는 힌트 등. */
  children?: React.ReactNode;
  testId?: string;
}) {
  const seg = (on: boolean) => `rounded px-2 py-1 text-meta disabled:opacity-50 ${on ? 'bg-accent text-fg-on-strong' : 'border border-border text-fg hover:bg-surface-hover'}`;
  return (
    <div role="radiogroup" aria-label={label} className={`flex flex-wrap items-center gap-2 ${className}`} data-testid={testId}>
      {showLabel && <span>{label}</span>}
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={seg(value === o.value)}
          disabled={disabled || o.disabled} onClick={() => { onChange(o.value); o.onPick?.(); }}>
          {o.label}
        </button>
      ))}
      {children}
    </div>
  );
}
