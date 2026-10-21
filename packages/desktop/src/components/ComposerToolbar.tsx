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

const GROUPS: { kind: FormatKind; glyph: string; label: MessageKey; keys: string; cls?: string }[][] = [
  [
    { kind: 'bold', glyph: 'B', label: 'composer.fmt.bold', keys: '⌘B', cls: 'font-bold' },
    { kind: 'italic', glyph: 'I', label: 'composer.fmt.italic', keys: '⌘I', cls: 'italic' },
    { kind: 'strike', glyph: 'S', label: 'composer.fmt.strike', keys: '⌘⇧X', cls: 'line-through' },
  ],
  [{ kind: 'link', glyph: '🔗', label: 'composer.fmt.link', keys: '⌘K' }],
  [
    { kind: 'ordered', glyph: '1.', label: 'composer.fmt.ordered', keys: '⌘⇧7' },
    { kind: 'bullet', glyph: '•', label: 'composer.fmt.bullet', keys: '⌘⇧8' },
  ],
  [{ kind: 'quote', glyph: '❝', label: 'composer.fmt.quote', keys: '⌘⇧9' }],
  [
    { kind: 'code', glyph: '</>', label: 'composer.fmt.code', keys: '⌘E', cls: 'font-mono' },
    { kind: 'codeBlock', glyph: '{ }', label: 'composer.fmt.codeBlock', keys: '', cls: 'font-mono' },
  ],
];

export function ComposerToolbar({ onFormat }: { onFormat: (kind: FormatKind) => void }) {
  const t = useT();
  return (
    <div
      role="toolbar"
      aria-label={t('composer.fmt.toolbar')}
      data-testid="composer-toolbar"
      // 스레드 칸처럼 좁으면 가로로 밀린다(시안 — 스크롤바 없이). 동작줄은 그대로 둔다.
      className="flex items-center gap-0.5 overflow-x-auto border-b border-border px-2 py-1 [scrollbar-width:none]"
    >
      {GROUPS.map((group, gi) => (
        <div key={gi} className="flex shrink-0 items-center gap-0.5">
          {gi > 0 && <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />}
          {group.map((b) => {
            const name = t(b.label);
            return (
              <button
                key={b.kind}
                type="button"
                data-testid={`fmt-${b.kind}`}
                aria-label={name}
                title={b.keys ? `${name} (${b.keys})` : name}
                className={`min-w-7 rounded-row px-1.5 py-0.5 text-fg-muted hover:bg-surface-sunken hover:text-fg ${b.cls ?? ''}`}
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
  );
}
