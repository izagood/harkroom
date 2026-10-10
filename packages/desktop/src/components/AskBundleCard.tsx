import { useEffect, useRef, useState } from 'react';
import { isAskOpen, readAskBundleMeta, readAskMeta, type AskBundleItem, type MessageRow } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { selectAccountNames, type AccountNames } from '../lib/accountNames';
import { getController, type BundleAcceptResult } from '../state/controller';
import { useT } from '../i18n/useT';
import type { Translate } from '../i18n';

/**
 * **묶음 카드**(선택 카드 P1, 2026-10-10, 스레드 596146cc). 관리 에이전트가 여러 에이전트의 사람 앞 카드를 한 장에
 * 줄로 모은 것(`message.askBundle`). 시안 v2 8~13절.
 *
 * ## 줄의 상태는 원본에서 읽는다
 *
 * 묶음 meta 는 원본을 가리킬 뿐 상태를 싣지 않는다(정본은 하나). 그래서 줄마다 원본 카드를 `GET /messages/:id` 로
 * 읽는다 — 원본이 바뀌면 서버가 이 묶음에 `message.updated` 를 보내므로(`syncAskBundles`) 묶음 행이 바뀔 때마다
 * 다시 읽는다. 원본 채널을 볼 수 없으면(403) 그 줄은 「원본을 볼 수 없다」로 선다 — 지어내지 않는다.
 *
 * ## 고르는 것은 사람이다
 *
 * 칩을 누르면 원본에 **누른 사람 이름으로** 적힌다(`ask-bundle/answer`). 「남은 n개 추천대로」는 서버가 다시
 * 거른다 — 되돌릴 수 없는 줄·추천이 없는 줄·링크 줄은 빠지고, 빠진 까닭을 줄마다 보여 준다(security 3b ②).
 */
export function AskBundleCard({ message }: { message: MessageRow }) {
  // 모든 메시지 행이 이 컴포넌트를 지난다 — 묶음이 아니면 훅(원본 읽기)을 하나도 돌리지 않고 바로 빠진다.
  const bundle = readAskBundleMeta(message.meta);
  if (!bundle) return null;
  return <BundleCardBody message={message} items={bundle.items} />;
}

/** 「추천대로」를 누른 뒤 실제로 보내기까지 기다리는 초(시안 9절) — 답은 되돌릴 수 없어서 한 박자 둔다. */
export const BUNDLE_ACCEPT_DELAY_S = 5;

/** 서버가 일괄에서 **언제나** 빼는 결과 — 다시 눌러도 같으므로 n 에서 뺀다(#1288 designer s1). */
const ALWAYS_SKIPPED = new Set<BundleAcceptResult['outcome']>(['skipped_irreversible', 'skipped_link']);

function BundleCardBody({ message, items }: { message: MessageRow; items: AskBundleItem[] }) {
  const t = useT();
  const accounts = useActiveStore(selectAccountNames);
  const meIsHuman = useActiveStore((s) => s.me?.kind === 'human');
  const roots = useBundleRoots(message, items);
  const [results, setResults] = useState<BundleAcceptResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  /** 남은 초. null 이면 기다리는 중이 아니다. */
  const [countdown, setCountdown] = useState<number | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const notify = (key: 'speech.bundle.pickFailed' | 'speech.bundle.acceptFailed') => useActiveStore.getState().pushNotice(t(key));

  const rows = items.map((item) => ({ item, state: rowState(item, roots[item.rootId]) }));
  const open = rows.filter((r) => r.state.kind === 'open' || r.state.kind === 'link').length;
  const skipped = new Set((results ?? []).filter((r) => ALWAYS_SKIPPED.has(r.outcome)).map((r) => r.rootId));
  const recommendable = rows.filter((r) => r.state.kind === 'open' && !skipped.has(r.item.rootId)
    && recommendedOf(r.item, roots[r.item.rootId]) != null).length;

  const accept = async () => {
    setBusy(true);
    const got = await getController().acceptRecommendedBundle(message.id, message.channelId);
    if (!alive.current) return;
    setBusy(false);
    if (got == null) notify('speech.bundle.acceptFailed');
    else setResults(got);
  };

  // 5초를 센다. 0 이 되면 그때 보낸다 — 취소하면 아무것도 보내지 않는다(서버에는 답을 지우는 길이 없다).
  useEffect(() => {
    if (countdown == null) return;
    if (countdown <= 0) { setCountdown(null); void accept(); return; }
    const id = setTimeout(() => setCountdown((c) => (c == null ? null : c - 1)), 1000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown]);

  const pick = async (rootId: string, optionId: string) => {
    setPicking(rootId);
    const ok = await getController().answerBundleItem(message.id, message.channelId, rootId, optionId);
    if (!alive.current) return;
    setPicking(null);
    if (!ok) notify('speech.bundle.pickFailed');
  };

  return (
    <div data-testid="ask-bundle" className="mt-1.5 rounded-card border border-border-agent bg-surface">
      <div className="flex items-baseline gap-2 px-3 pt-2">
        <span data-testid="ask-bundle-head" className={`text-meta font-semibold ${open > 0 ? 'text-state-turn' : 'text-fg-agent'}`}>
          {open > 0 ? t('speech.bundle.remaining', { n: open, m: rows.length }) : t('speech.bundle.allDone', { m: rows.length })}
        </span>
      </div>
      <ul className="flex flex-col divide-y divide-border px-1 py-1">
        {rows.map(({ item, state }) => (
          <BundleRow
            key={item.rootId} item={item} state={state} accounts={accounts} t={t}
            canPick={meIsHuman && !busy && countdown == null && picking !== item.rootId}
            onPick={(optionId) => { void pick(item.rootId, optionId); }}
            result={results?.find((r) => r.rootId === item.rootId)}
          />
        ))}
      </ul>
      {meIsHuman && countdown != null && (
        <div data-testid="ask-bundle-pending" className="flex items-center gap-2 border-t border-border px-3 py-2 text-meta text-fg">
          <span>{t('speech.bundle.acceptPending', { n: recommendable, s: countdown })}</span>
          <button
            type="button" data-testid="ask-bundle-cancel"
            className="rounded-sm px-1 text-fg-muted underline underline-offset-2 hover:text-fg"
            onClick={() => setCountdown(null)}
          >
            {t('speech.bundle.acceptCancel')}
          </button>
        </div>
      )}
      {meIsHuman && countdown == null && recommendable > 0 && (
        <div className="border-t border-border px-3 py-2">
          <button
            type="button" data-testid="ask-bundle-accept" disabled={busy}
            className="rounded-row border border-border bg-surface-raised px-2.5 py-1 text-meta font-medium text-fg hover:border-state-turn hover:bg-surface-hover"
            onClick={() => setCountdown(BUNDLE_ACCEPT_DELAY_S)}
          >
            {t('speech.bundle.acceptRecommended', { n: recommendable })}
          </button>
          <span className="ml-2 text-meta text-fg-subtle">{t('speech.bundle.acceptNote')}</span>
        </div>
      )}
    </div>
  );
}

type RowState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'link' }
  | { kind: 'open'; root: MessageRow }
  | { kind: 'answered'; root: MessageRow; label: string | null; by: string | null }
  | { kind: 'replied'; root: MessageRow; note: string | null; noteBy: string | null; by: string | null }
  | { kind: 'superseded' }
  | { kind: 'declined' };

function rowState(item: AskBundleItem, root: MessageRow | 'unavailable' | undefined): RowState {
  if (root === undefined) return item.link ? { kind: 'link' } : { kind: 'loading' };
  if (root === 'unavailable') return item.link ? { kind: 'link' } : { kind: 'unavailable' };
  const ask = readAskMeta(root.meta);
  if (!ask) return { kind: 'unavailable' };
  if (ask.answeredWith != null) {
    return { kind: 'answered', root, label: ask.options.find((o) => o.id === ask.answeredWith)?.label ?? null, by: ask.answeredBy ?? null };
  }
  if (item.link && isAskOpen(ask)) return { kind: 'link' };
  if (ask.closedReason === 'replied') return { kind: 'replied', root, note: ask.replyNote ?? null, noteBy: ask.replyNoteBy ?? null, by: ask.closedBy ?? null };
  if (ask.closedReason === 'superseded') return { kind: 'superseded' };
  if (ask.closedAt != null) return { kind: 'declined' };
  return { kind: 'open', root };
}

/** 추천은 **원본의** 선택지에서 읽는다(서버와 같다) — 묶음의 사본은 모을 때의 것이다. 하나뿐일 때만. */
function recommendedOf(item: AskBundleItem, root: MessageRow | 'unavailable' | undefined): string | null {
  const ask = root && root !== 'unavailable' ? readAskMeta(root.meta) : null;
  const options = ask?.options ?? item.options;
  const rec = options.filter((o) => o.recommended === true);
  return rec.length === 1 ? rec[0]!.id : null;
}

function nameOf(accounts: AccountNames, id: string | null, t: Translate): string {
  if (!id) return t('common.someone');
  const a = accounts[id];
  return a ? (a.displayName || a.handle) : t('common.someone');
}

function BundleRow({ item, state, accounts, t, canPick, onPick, result }: {
  item: AskBundleItem; state: RowState; accounts: AccountNames; t: Translate;
  canPick: boolean; onPick: (optionId: string) => void; result?: BundleAcceptResult;
}) {
  const asker = nameOf(accounts, item.askerId, t);
  const goOriginal = () => { void getController().openMessage(item.rootId); };
  const settled = state.kind !== 'open' && state.kind !== 'link' && state.kind !== 'loading';
  return (
    <li data-testid={`ask-bundle-row-${item.rootId}`} data-state={state.kind} className="px-2 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-meta text-fg-subtle">{asker}</span>
        <span className={`min-w-0 truncate text-body ${settled ? 'text-fg-muted' : 'text-fg'}`}>{item.prompt}</span>
      </div>

      {state.kind === 'open' && (
        <div className="mt-1 flex flex-wrap gap-1">
          {readAskMeta(state.root.meta)!.options.map((o) => (
            <button
              key={o.id} type="button" disabled={!canPick}
              data-testid={`ask-bundle-option-${item.rootId}-${o.id}`}
              title={o.hint}
              className="rounded-full border border-border bg-surface-raised px-2.5 py-0.5 text-meta text-fg hover:border-state-turn hover:bg-surface-hover disabled:opacity-60"
              onClick={() => onPick(o.id)}
            >
              {o.label}
              {o.recommended && <span className="ml-1 text-fg-subtle">· {t('speech.bundle.recommended')}</span>}
            </button>
          ))}
          <button
            type="button" data-testid={`ask-bundle-reply-${item.rootId}`}
            className="rounded-sm px-1 text-meta text-fg-subtle underline decoration-dotted underline-offset-2 hover:text-fg-muted"
            onClick={goOriginal}
          >
            {t('speech.bundle.replyInThread')}
          </button>
        </div>
      )}
      {state.kind === 'link' && (
        <button type="button" data-testid={`ask-bundle-link-${item.rootId}`} className="mt-1 text-meta text-fg-muted underline underline-offset-2" onClick={goOriginal}>
          {t('speech.bundle.decideInThread')}
        </button>
      )}
      {state.kind === 'loading' && <p className="mt-0.5 text-meta text-fg-subtle">{t('speech.bundle.loading')}</p>}
      {state.kind === 'unavailable' && <p className="mt-0.5 text-meta text-fg-subtle">{t('speech.bundle.unavailable')}</p>}
      {state.kind === 'answered' && (
        <p className="mt-0.5 text-meta text-fg-subtle">
          {t('speech.bundle.answered', { label: state.label ?? '—', name: nameOf(accounts, state.by, t) })}
        </p>
      )}
      {state.kind === 'replied' && (
        <div className="mt-0.5">
          <p className="text-meta text-fg-subtle">{t('speech.bundle.replied', { name: nameOf(accounts, state.by, t) })}</p>
          {state.note && (
            <p data-testid={`ask-bundle-note-${item.rootId}`} className="mt-0.5 truncate border-l-2 border-border pl-2 text-meta text-fg-muted">
              {/* 요지는 관리 에이전트가 옮긴 말이다 — 사람의 말로 읽히지 않게 누가 요약했는지 밝힌다(security n1). */}
              {t('speech.bundle.noteBy', { name: nameOf(accounts, state.noteBy, t) })} {state.note}
            </p>
          )}
        </div>
      )}
      {state.kind === 'superseded' && <p className="mt-0.5 text-meta text-fg-subtle">{t('speech.ask.superseded')}</p>}
      {state.kind === 'declined' && <p className="mt-0.5 text-meta text-fg-subtle">{t('speech.ask.declined')}</p>}
      {result && result.outcome !== 'answered' && result.outcome !== 'resolved' && (
        <p data-testid={`ask-bundle-skip-${item.rootId}`} data-outcome={result.outcome} className="mt-0.5 text-meta text-fg-muted">
          {t(`speech.bundle.skip.${result.outcome}`)}
        </p>
      )}
    </li>
  );
}

/**
 * 줄마다 원본을 읽는다. 이미 받아 둔 채널 목록에 있으면 그것을 쓰고, 없으면 `GET /messages/:id`. 묶음 행(`message`)이
 * 바뀔 때마다 다시 읽는다 — 원본이 바뀌면 서버가 묶음에 `message.updated` 를 보낸다.
 */
function useBundleRoots(message: MessageRow, items: AskBundleItem[]): Record<string, MessageRow | 'unavailable'> {
  const [roots, setRoots] = useState<Record<string, MessageRow | 'unavailable'>>({});
  const key = items.map((i) => i.rootId).join(',');
  useEffect(() => {
    let alive = true;
    const controller = getController();
    void Promise.all(items.map(async (item) => {
      try {
        return [item.rootId, await controller.api.message(item.rootId)] as const;
      } catch {
        return [item.rootId, 'unavailable' as const] as const;
      }
    })).then((pairs) => { if (alive) setRoots(Object.fromEntries(pairs)); });
    return () => { alive = false; };
    // 묶음 행이 바뀌면(원본이 바뀌었다는 알림) 다시 읽는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, key]);
  return roots;
}
