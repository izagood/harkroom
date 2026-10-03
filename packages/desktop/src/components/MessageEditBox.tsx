import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useActiveStore } from '../state/communities';
import { NO_TEAMS } from '../state/appStore';
import { getController } from '../state/controller';
import { mentionQueryAt, applyMention, type MentionQuery } from '../lib/mention';
import { MentionSuggestList, mentionMatches } from './MentionSuggest';

interface Props {
  /** 고치는 중인 본문. 비우거나 바꾸는 것은 부르는 쪽(`MessageItem`)의 `draft` 다. */
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  onCancel: () => void;
  /** 이 메시지의 채널. 그 채널이 데리고 있는 에이전트를 후보 맨 위에 세운다 — 작성창과 같은 순서다. */
  channelId: string;
}

/**
 * 메시지 수정창(Save/Cancel 상자). 작성창과 **같은 멘션 추천**을 띄운다(2026-10-01).
 *
 * 전에는 맨 textarea 였다 — `@` 를 쳐도 목록이 없어서, 고치면서 상대를 더하려면 handle 을
 * 정확히 외워 쳐야 했다. 수정으로 넣은 멘션도 상대를 깨우므로(#924·#926) 틀린 글자는
 * 아무도 안 부른 수정이 된다.
 *
 * 후보와 목록은 `MentionSuggest` 의 것을 그대로 쓴다. 여기 있는 것은 **키보드의 우선순위**
 * 하나다: 목록이 열려 있으면 Enter/Tab 은 고르기, Esc 는 목록 닫기다. 그때 Enter 가 저장으로,
 * Esc 가 취소로 가면 `@ag` 까지 쳐 놓고 Enter 를 누른 사람은 반쯤 친 handle 을 저장하고,
 * 목록을 닫으려던 Esc 는 고친 글 전체를 버린다. 목록이 닫혀 있을 때는 예전 그대로다.
 *
 * 작성창의 고정 칩·`@` 버튼·자동 멘션 접두는 들이지 않는다 — 그것들은 **보낼 글**에 붙는
 * 것이고, 이미 보낸 글을 고칠 때 칩이 서면 본문에 없는 상대가 가는 것처럼 읽힌다.
 */
export function MessageEditBox({ value, onChange, onSave, onCancel, channelId }: Props) {
  const accounts = useActiveStore((s) => s.accounts);
  const groups = useActiveStore((s) => s.groups);
  // `null` 은 못 받은 것이다 — 후보 자리에서는 빈 목록이 사실이다(`Composer` 의 같은 줄 주석).
  const teams = useActiveStore((s) => s.teams) ?? NO_TEAMS;
  const myId = useActiveStore((s) => s.me?.id);
  const autoRows = useActiveStore((s) => s.channelAutoMentions[channelId]);
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);

  // 작성창의 `availableHandles` 와 같은 거르기다 — 비활성·나 자신은 맨 위에 세우지 않는다.
  const channelHandles = useMemo(
    () => (autoRows ?? [])
      .filter((r) => {
        const a = accounts[r.agentAccountId];
        return r.mode === 'available' && !!a && !a.disabled && a.id !== myId;
      })
      .map((r) => r.handle.toLowerCase()),
    [autoRows, accounts, myId],
  );
  const options = useMemo(
    () => mentionMatches(query, { accounts, groups, teams, myId, channelHandles }),
    [query, accounts, groups, teams, myId, channelHandles],
  );
  // 후보가 없으면 목록은 없는 것과 같다 — 그때 Enter 를 붙잡으면 저장이 안 된다.
  const open = query !== null && options.length > 0;

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null || !ref.current) return;
    pendingCaret.current = null;
    ref.current.setSelectionRange(caret, caret);
  }, [value]);

  const recompute = (text: string, caret: number | null) => {
    const next = caret === null ? null : mentionQueryAt(text, caret);
    if (query === null && next !== null) {
      // 작성창의 `recompute` 와 같은 이유로 열리는 순간에만 디렉터리를 당겨 온다.
      try {
        void getController().refreshAccounts().catch(() => {});
      } catch { /* 캐시된 후보로도 추천은 돌아야 한다 */ }
    }
    setQuery(next);
    setActive(0);
  };

  const choose = (handle: string) => {
    if (!query) return;
    const next = applyMention(value, query, handle);
    onChange(next.text);
    pendingCaret.current = next.caret;
    setQuery(null);
    setActive(0);
    ref.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % options.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + options.length) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        choose(options[active]!.handle);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setQuery(null);
        setActive(0);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSave(); }
    if (e.key === 'Escape') onCancel();
  };

  // 수정창은 여러 행에서 동시에 열릴 수 있다 — 목록 id 가 겹치면 `aria-activedescendant` 가 남의 항목을 가리킨다.
  const listId = `edit-mention-${useId()}`;

  return (
    <div className="space-y-1">
      <div
        data-testid="message-edit"
        className="relative"
        // 후보 버튼은 mousedown 을 막아 blur 를 일으키지 않는다 — 여기 오는 blur 는 상자 밖으로 나간 것이다.
        onBlur={(e) => {
          if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) return;
          setQuery(null);
        }}
      >
        <textarea
          ref={ref}
          className="w-full resize-none rounded-row border border-border bg-field px-2 py-1"
          rows={2}
          value={value}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            onChange(e.target.value);
            recompute(e.target.value, e.target.selectionStart);
          }}
          onSelect={(e) => {
            const t = e.currentTarget;
            recompute(t.value, t.selectionStart);
          }}
          onKeyDown={onKeyDown}
        />
        {open && (
          <MentionSuggestList
            id={listId}
            label="Mention suggestions"
            options={options}
            active={active}
            onActive={setActive}
            onChoose={choose}
            placement="below"
          />
        )}
      </div>
      <div className="flex gap-1">
        <button className="rounded-row border border-border px-1.5 text-meta text-fg-muted" onClick={onSave}>Save</button>
        <button className="rounded-row border border-border px-1.5 text-meta text-fg-muted" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
