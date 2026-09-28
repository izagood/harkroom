import type { ReactNode } from 'react';

/** 섹션 한 장의 껍데기 — 제목·설명·본문. 섹션마다 다시 만들면 여백이 어긋난다. */
export function SettingsPage({ title, description, width = 'default', children }: {
  title: string; description?: string; width?: 'default' | 'wide'; children: ReactNode;
}) {
  return (
    /*
      **폭은 화면이 고른다.** 기본은 `max-w-3xl`(768px) 이고 대부분 그대로다 — 설정 화면
      12개 중 11개는 한 줄에 한 필드를 쌓는 스택이라, 더 넓히면 라벨과 값이 멀어져 읽기만
      나빠진다(줄 길이는 좁을수록 낫다는 그 이유).

      `wide` 를 옵트인으로 낸 것은 **표인 화면**이 하나 있기 때문이다(`ClaudeAccounts`).
      계정 하나가 숫자 다섯 열을 갖는 화면에서 768px 은 그 숫자들을 세로로 쌓게 만들고,
      그러면 계정끼리 비교하는 일 — 그 화면이 존재하는 이유 — 이 불가능해진다.
      기본값을 바꾸지 않고 갈래를 하나 더 두는 쪽을 고른 이유가 이것이다: 넓혀야 할
      근거가 있는 화면만 넓힌다.
    */
    <div className={`${width === 'wide' ? 'max-w-6xl' : 'max-w-3xl'} px-10 py-10`}>
      {/*
        **화면 제목단 17px 은 이 자리다.** 24px(`text-2xl`)이었고 4단 밖이었다.

        설정 안의 `h2` 는 두 종류이고, 그 둘이 같은 단이면 위계가 없다 — 실측:
        `SettingsPage` 의 제목 1곳(12개 설정 화면이 이 껍데기를 쓴다)과, 두 칸 화면의
        **칸 제목** 6곳(`AgentsSettings`·`TeamsSettings`·`InviteSettings`·
        `HandleGroupsSettings` — 이 넷은 `SettingsPage` 를 쓰지 않고 자기 레이아웃을 짠다).
        전자는 "지금 어느 화면인가"에 답하므로 맨 윗단(17px)이고, 후자는 그 화면 안의 한
        칸 이름이므로 이름줄단(15px)이다. `ConnectScreen` 의 `h1` 이 전자와 같은 단이다.

        24 → 17px 로 내린 것이 눈에 작아 보이지 않는 이유: 본문이 14 → 13px 로 함께
        내려가 제목과 본문의 비가 1.71 → 1.31 이 아니라, 그 비를 굵기(`font-bold`)와
        여백(`mb-8`)이 이미 나눠 지고 있었다.
      */}
      <h2 className="text-title font-bold text-fg">{title}</h2>
      <p className="mt-1 mb-8 text-fg-subtle">{description ?? ''}</p>
      {children}
    </div>
  );
}

/** 카드 하나. 행 사이 구분선은 여기서만 긋는다. */
export function SettingsGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      {title && <h3 className="mb-2 text-body font-semibold text-fg-subtle">{title}</h3>}
      <div className="divide-y divide-border rounded-xl border border-border bg-surface-raised">
        {children}
      </div>
    </section>
  );
}

/** 고칠 수 없는 값을 보여 주는 행. 서버에 변경 엔드포인트가 없는 항목이 여기 온다. */
export function ReadonlyRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <span className="font-medium text-fg">{label}</span>
      <span className="ml-auto min-w-0 truncate text-fg-muted">{value}</span>
    </div>
  );
}

/** 스위치 한 줄. role="switch" 를 단 checkbox 라 키보드·스크린리더 동작이 그대로 산다. */
export function Toggle({ label, description, checked, disabled, onChange }: {
  label: string; description?: string; checked: boolean; disabled?: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <label className={`flex items-start gap-4 px-4 py-3 ${disabled ? 'opacity-50' : ''}`}>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-fg">{label}</span>
        {description && <span className="mt-0.5 block text-fg-subtle">{description}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-fg-subtle
                   transition before:block before:h-4 before:w-4 before:translate-x-0.5
                   before:translate-y-0.5 before:rounded-full before:bg-white before:transition
                   checked:bg-accent checked:before:translate-x-4 disabled:cursor-default"
      />
    </label>
  );
}

/*
 * ── 폼 프리미티브(identity 문서 · Task 15) ──────────────────────────────────
 *
 * 지금은 `const field = 'w-full rounded border ...'` 같은 문자열이 파일마다 따로 산다.
 * 세 곳을 비교해 보면 **이미 값이 갈라져 있다** — 하나는 `px-3 py-2`, 하나는 `px-2 py-1`,
 * 하나는 `mt-1` 이 붙어 있다. 같은 자리가 화면마다 다르게 생겼다는 뜻이다.
 *
 * 여기로 모으면 그 갈라짐이 없어지고, `AgentsSettings` 를 쪼갤 때 상세 화면이 **따라갈 것**이
 * 생긴다(그것이 이 Task 의 순서상 이 조각이 먼저인 이유다).
 */

/**
 * 입력 칸의 공통 모양. 라벨과 힌트를 함께 세우는 것이 이 프리미티브의 일이다.
 *
 * **크기는 라벨·힌트가 아랫단 11px, 입력칸이 본문단 13px 이다.** 입력칸에 크기를 적지
 * 않는 것은 앱 기본값이 본문단이기 때문이고(`Workspace.tsx`), 그것이 이 저장소의
 * 입력칸 규칙이다 — 방금 친 글자를 다시 읽는 자리다. 라벨은 12px 이었고 4단 밖이었다.
 */
const FIELD_BOX = 'w-full rounded border border-border bg-field px-3 py-2 text-fg placeholder-fg-subtle';
const FIELD_LABEL = 'block text-meta font-medium text-fg-muted';

/**
 * 라벨 + 입력 + 힌트 한 벌.
 *
 * **힌트는 한 자리에만 둔다**(문서 원칙 06): `placeholder` 는 예시만 담고 규칙은 아래 힌트
 * 줄로 내린다 — 두 곳에 나뉘면 사람이 규칙을 놓친다. 되돌릴 수 없는 것(이름 등)은
 * `tone="warning"` 으로 경고색을 받는다: "만든 뒤에는 바꿀 수 없다"가 화면에서 가장 작은
 * 회색 글씨면 아무도 읽지 않는다.
 */
export function Field({ label, hint, tone = 'muted', children }: {
  label: string;
  hint?: string;
  tone?: 'muted' | 'warning';
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className={FIELD_LABEL}>{label}</span>
      <span className="mt-1 block">{children}</span>
      {hint && (
        <span className={`mt-1 block text-meta ${tone === 'warning' ? 'text-warning' : 'text-fg-subtle'}`}>
          {hint}
        </span>
      )}
    </label>
  );
}

/** `Field` 안에 들어가는 한 줄 입력. 바깥에서 쓰려면 `Field` 로 감싼다. */
export function TextInput({ value, onChange, placeholder, disabled, ariaLabel }: {
  value: string;
  onChange(next: string): void;
  placeholder?: string;
  disabled?: boolean;
  /** `Field` 의 라벨과 연결되지 않는 자리(그리드 안 등)에서만 쓴다. */
  ariaLabel?: string;
}) {
  return (
    <input
      className={FIELD_BOX}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** 고르는 값. 옵션이 둘~셋이면 `Segmented` 가 낫다 — 펼치지 않고 전부 보인다. */
export function Select({ value, onChange, options, disabled, ariaLabel }: {
  value: string;
  onChange(next: string): void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <select
      className={FIELD_BOX}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/**
 * 서로 배타적인 몇 개 중 하나. **`radiogroup` 이다** — 보이는 것이 버튼 무리라도 스크린리더에
 * 게는 "여럿 중 하나"로 읽혀야 하고, 그래야 화살표 키가 자연스럽다.
 */
export function Segmented({ value, onChange, options, label }: {
  value: string;
  onChange(next: string): void;
  options: { value: string; label: string }[];
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-lg bg-surface-sunken p-1">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            className={`flex-1 rounded-md px-3 py-1.5 text-body font-medium ${
              on ? 'bg-accent text-fg-on-strong' : 'text-fg-muted hover:bg-surface-hover'
            }`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 버튼 한 벌. **`danger` 를 따로 두는 것이 요점**이다 — 되돌릴 수 없는 조작이 보통 버튼과
 * 같게 생기면 사람이 그것을 구별할 수단이 색밖에 없고, 색은 테마에 따라 흐려진다.
 */
export function Button({ children, onClick, variant = 'secondary', disabled, type = 'button', ariaLabel }: {
  children: ReactNode;
  onClick?(): void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
  /**
   * 보이는 글자와 **접근성 이름을 가를 때만** 쓴다. 같은 글자의 버튼이 여러 개 서는
   * 화면에서 필요하다 — 풀마다 `Add account` 가 하나씩 서면 보는 사람은 어느 풀의
   * 것인지 자리로 알지만, 스크린리더는 같은 이름 넷을 읽는다. 보이는 글자에 풀 이름을
   * 넣어 해결하던 것을(`Add account to work`) 이름으로 옮긴 자리다.
   */
  ariaLabel?: string;
}) {
  const tone = {
    primary: 'bg-accent text-fg-on-strong hover:bg-accent-hover',
    secondary: 'border border-border bg-surface-raised text-fg hover:bg-surface-hover',
    danger: 'border border-danger-border text-danger hover:bg-danger-surface',
  }[variant];
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      aria-label={ariaLabel}
      className={`rounded px-3 py-1.5 text-body font-medium disabled:opacity-50 ${tone}`}
    >
      {children}
    </button>
  );
}
