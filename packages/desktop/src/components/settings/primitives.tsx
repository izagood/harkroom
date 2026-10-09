import { useId, type ReactNode } from 'react';
import { useT } from '../../i18n/useT';
import { navKey, type SectionId } from './sections';

/** 섹션 한 장의 껍데기 — 제목·설명·본문. 섹션마다 다시 만들면 여백이 어긋난다. */
export function SettingsPage({ section, description, width = 'default', layout, children }: {
  /**
   * 이 페이지가 **목차의 어느 줄인가**. 제목은 그 줄과 같은 사전 키에서 나온다(`navKey`) —
   * 제목을 따로 받으면 목차 이름과 페이지 제목이 다시 갈라진다(UX ④ H5: "Appearance" 를
   * 눌렀는데 "모양" 이 열렸다). 목차에 없는 페이지는 없다.
   */
  section: SectionId; description?: ReactNode; width?: 'default' | 'wide';
  /**
   * 화면의 **꼴**(설정 폭 시안 v1 규칙 ①). 주면 `width` 는 무시되고 `SettingsWrap` 이 상한·가운데
   * 정렬·컨테이너를 맡는다. 아직 옵트인이다 — 화면을 하나씩 옮기는 PR 에서 붙이고, 다 옮기면
   * `width` 갈래를 지운다. 기본값을 바로 바꾸지 않은 것은 이 PR 의 보이는 변화를 0 으로 두려고다.
   */
  layout?: SettingsLayout; children: ReactNode;
}) {

  if (layout) {
    return (
      <SettingsWrap layout={layout} className="py-10">
        <SettingsHeader section={section} description={description} measure />
        {children}
      </SettingsWrap>
    );
  }

  return (
    /*
      **폭은 화면이 고른다.** 기본은 **640px** 이다(UX ⑤ designer 사양 — 768px `max-w-3xl` 이었고,
      그 폭에서는 라벨과 값이 멀어졌다). 대부분 그대로다 — 설정 화면
      12개 중 11개는 한 줄에 한 필드를 쌓는 스택이라, 더 넓히면 라벨과 값이 멀어져 읽기만
      나빠진다(줄 길이는 좁을수록 낫다는 그 이유).

      `wide` 를 옵트인으로 낸 것은 **표인 화면**이 하나 있기 때문이다(`ClaudeAccounts`).
      계정 하나가 숫자 다섯 열을 갖는 화면에서 768px 은 그 숫자들을 세로로 쌓게 만들고,
      그러면 계정끼리 비교하는 일 — 그 화면이 존재하는 이유 — 이 불가능해진다.
      기본값을 바꾸지 않고 갈래를 하나 더 두는 쪽을 고른 이유가 이것이다: 넓혀야 할
      근거가 있는 화면만 넓힌다.
    */
    <div className={`${width === 'wide' ? 'max-w-6xl' : 'max-w-[640px]'} px-10 py-10`}>
      {/*
        **화면 제목단 17px 은 이 자리다.** 24px(`text-2xl`)이었고 4단 밖이었다.

        설정 안의 `h2` 는 두 종류이고, 그 둘이 같은 단이면 위계가 없다 — 실측:
        `SettingsPage` 의 제목 1곳(12개 설정 화면이 이 껍데기를 쓴다)과, 두 칸 화면의
        **칸 제목** 6곳(`AgentsSettings`·`TeamsSettings`·`InviteSettings`·
        `HandleGroupsSettings` — 이 넷은 `SettingsPage` 를 쓰지 않고 자기 레이아웃을 짠다).
        전자는 "지금 어느 화면인가"에 답하므로 맨 윗단(17px)이고, 후자는 그 화면 안의 한
        칸 이름이므로 이름줄단(15px)이다. `ConnectScreen` 의 `h1` 이 전자와 같은 단이다.

        24 → 17px 로 내린 것이 눈에 작아 보이지 않는 이유: 본문이 14 → 13px 로 함께
        내려가 제목과 본문의 비가 1.71 → 1.31 이 아니라, 그 비를 굵기(`font-semibold`)와
        여백(`mb-8`)이 이미 나눠 지고 있었다.
      */}
      <SettingsHeader section={section} description={description} />
      {children}
    </div>
  );
}

/**
 * 설정 화면의 꼴 셋(설정 폭 시안 v1, designer · jaebin 승인).
 *
 * - `form` — 한 줄에 한 필드를 쌓는 짧은 폼. 상한 880px.
 * - `cards` — 카드 여러 장. 상한 1680px, 칸은 `SettingsColumns` 가 본문 폭으로 나눈다.
 * - `list` — 줄마다 값이 여럿인 목록·표. 상한 2200px, 표·격자로 채운다.
 *
 * 640px 을 고른 근거(라벨과 값이 멀어진다)는 그대로 맞다. 그래서 폭을 늘려 한 줄을 길게 하지 않고
 * **칸 수**를 늘린다 — 라벨과 값 사이는 `KvRow` 가 지킨다. 상한을 넘는 창에서는 **가운데**에
 * 선다(남는 폭이 오른쪽에 몰리면 덜 그려진 화면으로 읽힌다 — jaebin 이 첨부한 개요 탭이 그랬다).
 */
export type SettingsLayout = 'form' | 'cards' | 'list';

/** 꼴별 상한. px 로 적는다 — 규칙이 px 로 정해졌고, `--spacing` 척도를 따라 커지면 안 되는 값이다. */
export const SETTINGS_LAYOUT_MAX: Record<SettingsLayout, string> = {
  form: 'max-w-[880px]',
  cards: 'max-w-[1680px]',
  list: 'max-w-[2200px]',
};

/**
 * 설정 본문의 **컨테이너 한 겹** — 상한·가운데 정렬·좌우 여백, 그리고 칸 나누기가 재는 자(`@container`).
 *
 * **머리·탭·본문·저장 바는 같은 꼴의 `SettingsWrap` 에 각각 선다**(규칙 ②). 에이전트 편집처럼
 * 머리 줄과 탭 줄이 창 끝까지 선을 긋는 화면은 선은 바깥 요소가 긋고, 안의 글자·단추는 이 겹이
 * 상한 안에 세운다 — 그래야 중지/재시작 단추가 본문 오른쪽 끝에 맞는다(지금은 2000px 가까이 떨어진다).
 *
 * 칸은 **창이 아니라 이 겹의 폭**으로 나눈다(규칙 ④) — 목차 256px·앱 배율이 들어가도 같은 결과다.
 */
export function SettingsWrap({ layout, className = '', testId, children }: {
  layout: SettingsLayout; className?: string; testId?: string; children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      data-settings-layout={layout}
      className={`@container/settings mx-auto w-full ${SETTINGS_LAYOUT_MAX[layout]} px-6 @min-[1100px]/settings:px-10 ${className}`}
    >
      {children}
    </div>
  );
}

const COLS_PAIR = '@min-[1000px]/settings:grid-cols-2';
const COLS_SIDE = '@min-[900px]/settings:grid-cols-[minmax(0,1fr)_380px]';
const COLS_THREE = '@min-[1560px]/settings:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_400px]';
const SIDE_AT_TWO = '@min-[900px]/settings:col-start-2 @min-[900px]/settings:row-start-1';
const SIDE_AT_THREE = '@min-[900px]/settings:col-start-2 @min-[900px]/settings:row-start-1 @min-[900px]/settings:row-span-2 '
  + '@min-[1560px]/settings:col-start-3 @min-[1560px]/settings:row-span-1';
const SECONDARY_AT_THREE = '@min-[1560px]/settings:col-start-2 @min-[1560px]/settings:row-start-1';

/**
 * 카드형 화면의 칸 나누기(규칙 ④). `SettingsWrap` 안에서 쓴다 — 그 폭을 잰다.
 *
 * | 본문 폭 | 칸 |
 * |---|---|
 * | 900 미만 | 1단. `main` → `secondary` → `side` 순으로 쌓인다(지금과 같다) |
 * | 900 – 1560 | 주 칸 + 곁 칸 380. `secondary` 는 주 칸 아래로 |
 * | 1560 이상 | `secondary` 가 있으면 3단(1.2fr · 1fr · 400), 없으면 2단 그대로 |
 *
 * 3단을 `secondary` 가 있을 때만 여는 것은 카드가 셋 미만인 화면에서 빈 칸이 서지 않게 하려고다.
 * 곁 칸은 요약·위험 조작 자리다 — 위험 구역(`DangerZone`)은 곁 칸 **맨 아래**에 둔다(규칙 ⑦).
 */
export function SettingsColumns({ main, secondary, side, testId }: {
  main: ReactNode; secondary?: ReactNode; side?: ReactNode; testId?: string;
}) {
  const three = secondary != null;
  // 클래스는 **통째 문자열로만** 적는다 — Tailwind 는 소스 글자를 훑어 클래스를 찾으므로
  // 템플릿으로 이어 붙인 조각(닫는 `]` 바로 뒤에 `${…}` 를 붙인 꼴)은 CSS 가 생기지
  // 않는다(이 PR 첫 판에서 실측 — 900 칸이 안 섰다).
  const grid = side == null
    ? (three ? COLS_PAIR : '')
    : (three ? `${COLS_SIDE} ${COLS_THREE}` : COLS_SIDE);
  const sideAt = side == null ? '' : (three ? SIDE_AT_THREE : SIDE_AT_TWO);
  const secondaryAt = three && side != null ? SECONDARY_AT_THREE : '';
  return (
    <div data-testid={testId} className={`grid grid-cols-1 items-start gap-4 ${grid}`}>
      <div data-settings-col="main" className="flex min-w-0 flex-col gap-4">{main}</div>
      {three && <div data-settings-col="secondary" className={`flex min-w-0 flex-col gap-4 ${secondaryAt}`}>{secondary}</div>}
      {side != null && <div data-settings-col="side" className={`flex min-w-0 flex-col gap-4 ${sideAt}`}>{side}</div>}
    </div>
  );
}

const LIST_GRID = 'grid grid-cols-1 items-start gap-3 @min-[1100px]/settings:grid-cols-2 @min-[1700px]/settings:grid-cols-3';

/**
 * 목록형 화면의 **격자**(규칙 ④ list) — 줄 하나가 칸 하나다. `SettingsWrap` 안에서 그 폭을 잰다.
 *
 * | 본문 폭 | 칸 |
 * |---|---|
 * | 1100 미만 | 1단(지금과 같다) |
 * | 1100 – 1700 | 2단 |
 * | 1700 이상 | 3단 |
 *
 * 줄을 길게 늘이지 않고 칸 수를 늘린다 — 줄마다 값이 3~6개라 2200px 한 줄이면 이름과 단추가
 * 1500px 넘게 떨어진다. 칸 하나가 360~700px 사이에 머문다. `items-start` 라 펼친 줄이 이웃 줄을
 * 같이 늘이지 않는다.
 */
export function SettingsGrid({ as = 'div', testId, className = '', children }: {
  as?: 'div' | 'ul'; testId?: string; className?: string; children: ReactNode;
}) {
  const Tag = as;
  return <Tag data-testid={testId} data-settings-grid="" className={`${LIST_GRID} ${className}`}>{children}</Tag>;
}

/**
 * 라벨-값 두 열 행(규칙 ⑥) — 라벨 120px 오른쪽 맞춤 + 값 상한 440px. 칸이 넓어져도 라벨과 값
 * 사이가 벌어지지 않는다. 640px 결정이 지키던 것을 폭 대신 이 행이 지킨다.
 *
 * 값이 입력 칸이면 `htmlFor` 로 이어 라벨을 눌러 포커스가 가게 한다.
 */
export function KvRow({ label, htmlFor, testId, stacked = false, children }: {
  label: ReactNode; htmlFor?: string; testId?: string;
  /**
   * 라벨을 값 **위에** 쌓는다. 곁 칸(380) 안에서 쓴다 — 두 열이면 값 칸이 210px 남짓으로 줄어
   * 입력이 잘린다(designer #1254 n2).
   */
  stacked?: boolean; children: ReactNode;
}) {
  const labelClass = stacked
    ? 'text-meta font-medium text-fg-muted'
    : 'text-right text-meta font-medium text-fg-muted';
  const rowClass = stacked
    ? 'flex flex-col gap-1'
    : 'grid grid-cols-[120px_minmax(0,440px)] items-center gap-x-3.5';
  return (
    <div data-testid={testId} className={rowClass}>
      {htmlFor
        ? <label htmlFor={htmlFor} className={labelClass}>{label}</label>
        : <span className={labelClass}>{label}</span>}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** `KvRow` 여럿의 묶음 — 행 사이 10px(시안 값). 쓰는 곳마다 간격을 적지 않게 한 자리에 둔다(designer #1254 n1). */
export function KvRows({ testId, children }: { testId?: string; children: ReactNode }) {
  return <div data-testid={testId} className="flex flex-col gap-[10px]">{children}</div>;
}

/**
 * 되돌릴 수 없는 조작(비활성·삭제·폐기)을 묶는 카드 한 장(규칙 ⑦). 자식 하나가 조작 하나이고,
 * 그 사이 선은 여기서 긋는다. 곁 칸 맨 아래에 두고, 1단으로 접히면 화면 맨 끝이 된다. 단추는
 * 넓어지지 않는다 — 넓은 빨간 단추는 누르라는 뜻으로 읽힌다.
 */
export function DangerZone({ title, testId, children }: {
  title?: string; testId?: string; children: ReactNode;
}) {
  const t = useT();
  const headingId = useId();
  return (
    <section
      data-testid={testId}
      aria-labelledby={headingId}
      className="rounded-compose border border-danger-border bg-danger-surface"
    >
      <h3 id={headingId} className="px-4 pt-3 text-meta font-semibold text-danger">{title ?? t('settings.dangerZone')}</h3>
      <div className="divide-y divide-danger-border [&>*]:px-4 [&>*]:py-3">{children}</div>
    </section>
  );
}

/**
 * 설정 페이지의 **머리 한 벌**(UX ⑤b) — 제목(목차 줄과 같은 키)과 부제. `SettingsPage` 가 쓰고,
 * `SettingsPage` 를 못 쓰는 두 칸 화면(목록 + 상세: 핸들 그룹)도 이것을 위에 얹는다. 머리가
 * 화면마다 달랐다(M2) — 어떤 화면은 17px 제목, 어떤 화면은 15px 칸 제목만 있었다.
 */
export function SettingsHeader({ section, description, className = '', measure = false }: {
  section: SectionId; description?: ReactNode; className?: string;
  /** 부제를 68ch 에서 끊는다(규칙 ⑤). `layout` 으로 넓힌 화면만 켠다 — 640px 화면은 이미 그 안이다. */
  measure?: boolean;
}) {
  const t = useT();
  return (
    <div className={className}>
      <h2 className="text-title font-semibold text-fg">{t(navKey(section))}</h2>
      <p className={measure ? 'mt-1 mb-8 max-w-[68ch] text-fg-subtle' : 'mt-1 mb-8 text-fg-subtle'}>{description ?? ''}</p>
    </div>
  );
}

/** 카드 하나. 행 사이 구분선은 여기서만 긋는다. */
export function SettingsGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      {title && <h3 className="mb-2 text-body font-semibold text-fg-subtle">{title}</h3>}
      <div className="divide-y divide-border rounded-compose border border-border bg-surface-raised">
        {children}
      </div>
    </section>
  );
}

/** 고칠 수 없는 값을 보여 주는 행. 서버에 변경 엔드포인트가 없는 항목이 여기 온다. */
export function ReadonlyRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      {/* 라벨은 꺾이지 않는다 — 값이 길면 값 쪽이 줄어든다(#1173 에서 "New version" 이 두 줄로 꺾였다). */}
      <span className="shrink-0 whitespace-nowrap font-medium text-fg">{label}</span>
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
      <Switch ariaLabel={label} checked={checked} disabled={disabled} onChange={onChange} className="mt-0.5" />
    </label>
  );
}

/**
 * 켜고 끄는 스위치 하나(UX ④c). `Toggle` 은 설정 한 줄 전체이고, 이것은 **목록 줄 안에 서는
 * 스위치**다 — 자동화 줄의 "켜짐" 이 맨 체크박스(파란 네모)였고, 같은 일을 하는 것이 화면마다
 * 다른 컨트롤로 보였다(M9). 이제 켜기/끄기는 모두 이 모양 하나다.
 */
export function Switch({ checked, disabled, onChange, ariaLabel, testId, className = '' }: {
  checked: boolean; disabled?: boolean; onChange(next: boolean): void;
  ariaLabel?: string; testId?: string; className?: string;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      aria-label={ariaLabel}
      data-testid={testId}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className={`${className} h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-fg-subtle
                 transition before:block before:h-4 before:w-4 before:translate-x-0.5
                 before:translate-y-0.5 before:rounded-full before:bg-white before:transition
                 checked:bg-accent checked:before:translate-x-4 disabled:cursor-default`}
    />
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
const FIELD_BOX = 'w-full rounded-row border border-border bg-field px-3 py-2 text-fg placeholder-fg-subtle';
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
    <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-card bg-surface-sunken p-1">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            className={`flex-1 rounded-row px-3 py-1.5 text-body font-medium ${
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
      className={`rounded-row px-3 py-1.5 text-body font-medium disabled:opacity-50 ${tone}`}
    >
      {children}
    </button>
  );
}

/**
 * 바로 저장하는 화면의 **저장 상태 한 줄**(UX ⑤). 저장 버튼을 걷어 내면 "눌렀는데 들어갔나" 를
 * 말할 자리가 이것 하나다 — 도는 중·저장됨·실패를 같은 자리에서 말한다. 실패는 `role="alert"`.
 */
export type SaveState = 'idle' | 'saving' | 'saved' | 'failed';
export function SaveStatus({ state, failedLabel }: { state: SaveState; failedLabel: string }) {
  const t = useT();
  if (state === 'idle') return null;
  if (state === 'failed') return <p role="alert" className="text-meta text-danger">{failedLabel}</p>;
  return (
    <p role="status" data-testid="save-status" className={`text-meta ${state === 'saved' ? 'text-success' : 'text-fg-muted'}`}>
      {state === 'saved' ? t('settings.saved') : t('settings.saving')}
    </p>
  );
}
