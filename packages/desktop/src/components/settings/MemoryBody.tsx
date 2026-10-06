import { Fragment, useMemo, type ReactNode } from 'react';
import { splitCode } from '@harkroom/shared';
import { parseBlocks, type Block, type Inline } from '../../lib/markdown';
import { WIKI_LINK } from '../../lib/memoryList';
import { useT } from '../../i18n/useT';

/**
 * 기억 본문을 **읽는 모양**으로 그린다(Memory 탭 PR 4). 메시지 본문과 같은 파서(`lib/markdown`)를
 * 쓰므로 `dangerouslySetInnerHTML` 이 들어올 자리가 없다 — 기억도 에이전트가 쓴 신뢰할 수 없는
 * 글이다. `MessageBody` 를 그대로 쓰지 않는 이유: 그것은 멘션 칩·링크 미리보기 카드를 서버에
 * 묻는다. 기억 상세는 그 왕복이 필요 없고, 설정 화면에서 바깥 주소를 열 일도 없다 — 그래서
 * `[글자](주소)` 는 글자로만 그리고 주소는 `title` 로 보인다.
 *
 * `[[이름]]` 만 누를 수 있다. 가리키는 기억이 살아 있으면 그 기억을 상세에 열고, 보관됐으면
 * 「보관됨」 표와 함께 연다(되살릴지 정하는 자리), 없으면 빨강(깨짐)이다.
 */
export type WikiLinkState = 'active' | 'archived' | 'missing';

export function MemoryBody({
  value,
  linkState,
  onOpenLink,
}: {
  value: string;
  linkState: (target: string) => WikiLinkState;
  onOpenLink: (target: string) => void;
}) {
  const t = useT();
  const blocks = useMemo(() => parseBlocks(splitCode(value)), [value]);

  const wiki = (text: string, key: string): ReactNode[] => {
    const out: ReactNode[] = [];
    let last = 0;
    for (const m of text.matchAll(WIKI_LINK)) {
      const at = m.index ?? 0;
      if (at > last) out.push(text.slice(last, at));
      const target = m[1]!;
      const state = linkState(target);
      out.push(
        <button
          key={`${key}-w${at}`}
          type="button"
          data-testid={`memory-link-${target}`}
          data-state={state}
          disabled={state === 'missing'}
          title={state === 'missing' ? t('agents.memory.linkMissing') : state === 'archived' ? t('agents.memory.linkArchived') : undefined}
          className={`underline decoration-dotted ${
            state === 'missing' ? 'cursor-default text-danger' : state === 'archived' ? 'text-fg-muted' : 'text-fg-agent'
          }`}
          onClick={() => onOpenLink(target)}
        >
          {`[[${target}]]`}
        </button>,
      );
      last = at + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  };

  const spans = (list: Inline[], key: string) => list.map((s, i) => {
    const k = `${key}-${i}`;
    if (s.kind === 'code') return <code key={k} className="rounded-sm bg-surface-sunken px-0.5">{s.code}</code>;
    const body = s.kind === 'link' ? <span title={s.href}>{s.text}</span> : wiki(s.text, k);
    const cls = [s.strong && 'font-semibold', s.em && 'italic', s.strike && 'line-through'].filter(Boolean).join(' ');
    return <span key={k} className={cls || undefined}>{body}</span>;
  });

  const block = (b: Block, key: string): ReactNode => {
    switch (b.kind) {
      case 'heading':
        return <p key={key} role="heading" aria-level={b.level} className="mt-2 mb-1 font-semibold text-fg first:mt-0">{spans(b.spans, key)}</p>;
      case 'quote':
        return <blockquote key={key} className="mb-1 border-l-2 border-border pl-2">{spans(b.spans, key)}</blockquote>;
      case 'rule':
        return <hr key={key} className="my-2 border-border" />;
      case 'code':
        return <pre key={key} className="mb-1 overflow-x-auto rounded-sm bg-surface-sunken p-1 whitespace-pre">{b.code}</pre>;
      case 'list': {
        const List = b.ordered ? 'ol' : 'ul';
        return (
          <List key={key} start={b.ordered ? b.start : undefined} className={`mb-1 ml-4 ${b.ordered ? 'list-decimal' : 'list-disc'}`}>
            {b.items.map((it, i) => (
              <li key={i}>
                {spans(it.spans, `${key}-${i}`)}
                {it.children.map((c, j) => block(c, `${key}-${i}-${j}`))}
              </li>
            ))}
          </List>
        );
      }
      case 'table':
        return (
          <div key={key} className="mb-1 overflow-x-auto">
            <table className="border-collapse">
              <thead><tr>{b.head.map((c, i) => <th key={i} className="border border-border px-1 text-left">{spans(c, `${key}-h${i}`)}</th>)}</tr></thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>{r.map((c, ci) => <td key={ci} className="border border-border px-1 align-top">{spans(c, `${key}-${ri}-${ci}`)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      default:
        return <p key={key} className="mb-1 last:mb-0">{spans(b.spans, key)}</p>;
    }
  };

  return (
    <div data-testid="memory-body" className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-meta text-fg-muted">
      {blocks.map((b, i) => <Fragment key={i}>{block(b, `b${i}`)}</Fragment>)}
    </div>
  );
}
