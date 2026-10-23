import type { ReactNode } from 'react';
import { useT } from '../i18n/useT';
import type { MessageKey } from '../i18n';

/**
 * 입력창 위 서식 도구줄(입력창 개편 P2, 시안 v1). 순서는 시안 그대로:
 * B · I · S │ 링크 │ 번호·글머리 목록 │ 인용 │ 코드 · 코드 블록. 밑줄은 없다(결정 4 — 메시지 마크다운에 밑줄이 없다).
 *
 * 단추는 **단축키와 같은 길**을 탄다(`Composer` 의 `applyFormat`) — 단추와 열쇠가 다른 기호를 넣으면 같은
 * 서식이 두 모양으로 남는다. 툴팁에 단축키를 같이 적는다(시안 키보드 표).
 *
 * 누르는 동안 편집기의 포커스를 뺏지 않는다(`onMouseDown` preventDefault) — 뺏기면 고른 범위가 사라져
 * 감쌀 글이 없어진다.
 */
export type FormatKind = 'bold' | 'italic' | 'strike' | 'link' | 'ordered' | 'bullet' | 'quote' | 'code' | 'codeBlock';

/**
 * 링크·목록·인용은 단색 선 아이콘이다(#1431 designer 3). 컬러 이모지(🔗)나 글자 기호(`1.`·`•`·`❝`)는 크기·굵기가
 * 제각각이라 단추들 사이에서 튄다. 16px · `currentColor` · 선 1.6 — 글자 단추(B·I·S)와 같은 색을 따른다.
 */
const icon = (d: string) => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
const LINK = icon('M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1');
const ORDERED = icon('M6.5 4h7M6.5 8h7M6.5 12h7M2.5 3l1-.5V6M2.3 9.6a.9.9 0 0 1 1.6.6L2.3 12.5h1.8');
const BULLET = icon('M6.5 4h7M6.5 8h7M6.5 12h7M3 4h.01M3 8h.01M3 12h.01');
const QUOTE = icon('M3 3.5v9M6.5 5h6.5M6.5 8h6.5M6.5 11h4');

const GROUPS: { kind: FormatKind; glyph: ReactNode; label: MessageKey; keys: string; cls?: string }[][] = [
  [
    { kind: 'bold', glyph: 'B', label: 'composer.fmt.bold', keys: '⌘B', cls: 'font-bold' },
    { kind: 'italic', glyph: 'I', label: 'composer.fmt.italic', keys: '⌘I', cls: 'italic' },
    { kind: 'strike', glyph: 'S', label: 'composer.fmt.strike', keys: '⌘⇧X', cls: 'line-through' },
  ],
  [{ kind: 'link', glyph: LINK, label: 'composer.fmt.link', keys: '⌘K' }],
  [
    { kind: 'ordered', glyph: ORDERED, label: 'composer.fmt.ordered', keys: '⌘⇧7' },
    { kind: 'bullet', glyph: BULLET, label: 'composer.fmt.bullet', keys: '⌘⇧8' },
  ],
  [{ kind: 'quote', glyph: QUOTE, label: 'composer.fmt.quote', keys: '⌘⇧9' }],
  [
    { kind: 'code', glyph: '</>', label: 'composer.fmt.code', keys: '⌘E', cls: 'font-mono' },
    { kind: 'codeBlock', glyph: '{ }', label: 'composer.fmt.codeBlock', keys: '⌘⌥C', cls: 'font-mono' },
  ],
];

export function ComposerToolbar({ onFormat, active }: { onFormat: (kind: FormatKind) => void; active?: ReadonlySet<FormatKind> }) {
  const t = useT();
  return (
    <div
      role="toolbar"
      aria-label={t('composer.fmt.toolbar')}
      data-testid="composer-toolbar"
      // 좁은 칸(스레드 패널)에서는 묶음째 다음 줄로 넘긴다 — 가로로 밀어 두면 오른쪽 단추가 잘려 보이고, 밀 수 있다는 표시도 없다.
      className="border-b border-border px-2 py-1"
    >
      {/*
        묶음 사이 세로줄은 **각 묶음 왼쪽**에 붙인다(`before:`). 줄을 이은 줄 맨 앞에 홀로 남지 않게(#1491 designer 2), 줄 전체를
        세로줄 자리만큼 왼쪽으로 당기고(`-ml-[9px]`) 그 바깥을 자른다(`overflow-hidden`) — 어느 줄이든 첫 묶음의 세로줄은 잘린다.
      */}
      <div className="overflow-hidden">
        <div className="-ml-[9px] flex flex-wrap items-center gap-y-0.5">
      {GROUPS.map((group, gi) => (
        <div key={gi} className="relative flex shrink-0 items-center gap-0.5 pl-[9px] before:absolute before:left-1 before:top-1/2 before:h-4 before:w-px before:-translate-y-1/2 before:bg-border">
          {group.map((b) => {
            const name = t(b.label);
            return (
              <button
                key={b.kind}
                type="button"
                data-testid={`fmt-${b.kind}`}
                aria-label={name}
                // 커서가 그 서식 안에 있으면 켜짐(시안 「서식 적용 중」) — 누르면 벗긴다는 뜻이기도 하다.
                aria-pressed={active?.has(b.kind) ?? false}
                title={b.keys ? `${name} (${b.keys})` : name}
                className={`inline-flex h-7 min-w-7 items-center justify-center rounded-row px-1.5 hover:bg-surface-sunken hover:text-fg ${
                  active?.has(b.kind) ? 'bg-accent-surface text-accent' : 'text-fg-muted'
                } ${b.cls ?? ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onFormat(b.kind)}
              >
                {b.glyph}
              </button>
            );
          })}
        </div>
      ))}
        </div>
      </div>
    </div>
  );
}
