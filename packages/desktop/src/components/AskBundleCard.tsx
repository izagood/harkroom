import { useEffect, useRef, useState } from 'react';
import { ASK_TEXT_OPTION_ID, compareRelease, isAskOpen, readAskBundleMeta, readAskMeta, type AskBundleItem, type MessageRow } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { selectAccountNames, type AccountNames } from '../lib/accountNames';
import { getController, type BundleAcceptResult } from '../state/controller';
import { quoteLine } from './AskCard';
import { useT } from '../i18n/useT';
import type { Translate } from '../i18n';
import { answerErrorText, cardContextText, MandateLineBody, readRootSource, type CardSource } from './MandateLineBody';
import { elsewhereResult, lineResultKey, standingResultOf } from './AskCard';

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
 * 거른다 — 되돌릴 수 없는 줄·추천이 없는 줄·권한 줄은 빠지고, 빠진 까닭을 줄마다 보여 준다(security 3b ②).
 *
 * ## 권한 줄은 원본 카드를 펼쳐 그 자리에서 정한다
 *
 * 줄의 사본은 쓰지 않는다 — 원본의 대상·경고·이유를 그대로 그리고, 버튼은 원 카드와 같다. 판정은 서버(`decide`)가 원 카드와 같이 하고,
 * 여기는 버튼을 보일지만 정한다. 그 경로가 없는 옛 서버와 줄 없는 옛 카드는 전처럼 원 스레드 링크다.
 */
export function AskBundleCard({ message }: { message: MessageRow }) {
  // 모든 메시지 행이 이 컴포넌트를 지난다 — 묶음이 아니면 훅(원본 읽기)을 하나도 돌리지 않고 바로 빠진다.
  const bundle = readAskBundleMeta(message.meta);
  if (!bundle) return null;
  return <BundleCardBody message={message} items={bundle.items} />;
}

/** 「추천대로」를 누른 뒤 실제로 보내기까지 기다리는 초(시안 9절) — 답은 되돌릴 수 없어서 한 박자 둔다. */
export const BUNDLE_ACCEPT_DELAY_S = 5;

/** `ask-bundle/answer` 가 권한 줄을 받기 시작한 서버 릴리스. 그 앞 서버에는 지금처럼 링크로 그린다. */
export const BUNDLE_DECIDE_SINCE = '0.4.386';

/** 위에서부터 펼쳐 두는 권한 줄 수. 나머지는 한 줄로 두고 눌러야 펼친다 — 그 줄에는 결정 버튼이 없다(대상·경고·이유를 보기 전에 누르지 않게). 하나를 정해 접히면 다음 줄이 펼쳐진다. */
export const BUNDLE_OPEN_DECIDE_ROWS = 3;

/** 서버가 일괄에서 **언제나** 빼는 결과 — 다시 눌러도 같으므로 n 에서 뺀다(#1288 designer s1). */
const ALWAYS_SKIPPED = new Set<BundleAcceptResult['outcome']>(['skipped_irreversible', 'skipped_link']);

function BundleCardBody({ message, items }: { message: MessageRow; items: AskBundleItem[] }) {
  const t = useT();
  const accounts = useActiveStore(selectAccountNames);
  const meIsHuman = useActiveStore((s) => s.me?.kind === 'human');
  const roots = useBundleRoots(message, items);
  const serverVersion = useActiveStore((s) => s.serverVersion?.version ?? null);
  const decideHere = serverVersion !== null && (compareRelease(serverVersion, BUNDLE_DECIDE_SINCE) ?? -1) >= 0;
  const [results, setResults] = useState<BundleAcceptResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  /** 남은 초. null 이면 기다리는 중이 아니다. */
  const [countdown, setCountdown] = useState<number | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const notify = (key: 'speech.bundle.acceptFailed') => useActiveStore.getState().pushNotice(t(key));

  const rows = items.map((item) => ({ item, state: rowState(item, roots[item.rootId], decideHere) }));
  const open = rows.filter((r) => r.state.kind === 'open' || r.state.kind === 'link' || r.state.kind === 'decide').length;
  const firstDecideRows = new Set(rows.filter((r) => r.state.kind === 'decide').slice(0, BUNDLE_OPEN_DECIDE_ROWS).map((r) => r.item.rootId));
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

  const setRowError = (rootId: string, text: string | null) => setRowErrors((prev) => {
    const { [rootId]: _gone, ...rest } = prev;
    return text ? { ...rest, [rootId]: text } : rest;
  });
  const pick = async (rootId: string, optionId: string) => {
    setPicking(rootId);
    setRowError(rootId, null);
    const err = await getController().answerBundleItem(message.id, message.channelId, rootId, optionId);
    if (!alive.current) return;
    setPicking(null);
    if (err) setRowError(rootId, answerErrorText(err, t));
  };
  /** 답하지 않기 — 원 카드의 그 버튼과 같은 문. 묶음은 서버의 `message.updated` 로 다시 읽는다. */
  const decline = async (root: MessageRow) => {
    setRowError(root.id, null);
    try {
      await getController().api.closeAsk(root.channelId, root.id);
    } catch {
      if (alive.current) setRowError(root.id, t('speech.bundle.pickFailed'));
    }
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
            canDecide={meIsHuman}
            collapsed={state.kind === 'decide' && !firstDecideRows.has(item.rootId) && !expanded.has(item.rootId)}
            onExpand={() => setExpanded((prev) => new Set(prev).add(item.rootId))}
            onPick={(optionId) => { void pick(item.rootId, optionId); }}
            onDecline={(root) => { void decline(root); }}
            bundle={message}
            error={rowErrors[item.rootId] ?? null}
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
  /** 권한·머지 카드 — 원본을 펼쳐 그 자리에서 정한다. */
  | { kind: 'decide'; root: MessageRow; src: CardSource }
  | { kind: 'answered'; root: MessageRow; label: string | null; by: string | null }
  | { kind: 'replied'; root: MessageRow; note: string | null; noteBy: string | null; by: string | null }
  | { kind: 'superseded' }
  | { kind: 'expired' }
  | { kind: 'declined' };

function rowState(item: AskBundleItem, root: MessageRow | 'unavailable' | undefined, decideHere: boolean): RowState {
  // 표지(`link`)는 옛 서버에서만 뜻이 있다 — 새 서버의 권한 줄은 원본을 읽고 나서 정한다.
  if (root === undefined) return item.link && !decideHere ? { kind: 'link' } : { kind: 'loading' };
  if (root === 'unavailable') return item.link && !decideHere ? { kind: 'link' } : { kind: 'unavailable' };
  const ask = readAskMeta(root.meta);
  if (!ask) return { kind: 'unavailable' };
  if (ask.answeredWith != null) {
    return { kind: 'answered', root, label: ask.answeredWith === ASK_TEXT_OPTION_ID && ask.answeredText ? quoteLine(ask.answeredText) : ask.options.find((o) => o.id === ask.answeredWith)?.label ?? null, by: ask.answeredBy ?? null };
  }
  const pr = root.meta.permissionRequest as { status?: unknown; expiresAt?: unknown } | undefined;
  const isDecision = !!item.link || !!pr || root.meta.mergeDenial !== undefined;
  if (isDecision && isAskOpen(ask)) {
    // 시한이 지난 요청은 서버가 닫기 전이라도 버튼을 그리지 않는다(`AskCard` 와 같다) — 누르면 409 뿐이다.
    if (pr && (pr.status ?? 'pending') === 'pending' && typeof pr.expiresAt === 'string' && Date.parse(pr.expiresAt) <= Date.now()) return { kind: 'expired' };
    const src = decideHere ? readRootSource(root) : null;
    return src ? { kind: 'decide', root, src } : { kind: 'link' };
  }
  if (ask.closedReason === 'replied') return { kind: 'replied', root, note: ask.replyNote ?? null, noteBy: ask.replyNoteBy ?? null, by: ask.closedBy ?? null };
  if (ask.closedReason === 'superseded') return { kind: 'superseded' };
  // 권한 요청 시한이 지나 서버가 닫았다(스레드 65f3b26e) — 「답 없이 닫힘」으로 말하면 없던 결정을 읽힌다.
  if (ask.closedReason === 'expired') return { kind: 'expired' };
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

function BundleRow({ item, state, accounts, t, canPick, canDecide, collapsed, onExpand, onPick, onDecline, bundle, error, result }: {
  item: AskBundleItem; state: RowState; accounts: AccountNames; t: Translate;
  canPick: boolean; canDecide: boolean; collapsed: boolean; onExpand: () => void; onPick: (optionId: string) => void; onDecline: (root: MessageRow) => void;
  bundle: MessageRow; error: string | null; result?: BundleAcceptResult;
}) {
  const asker = nameOf(accounts, item.askerId, t);
  const goOriginal = () => { void getController().openMessage(item.rootId); };
  const settled = state.kind !== 'open' && state.kind !== 'link' && state.kind !== 'loading' && state.kind !== 'decide';
  return (
    <li data-testid={`ask-bundle-row-${item.rootId}`} data-state={state.kind} className="px-2 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 text-meta text-fg-subtle">{asker}</span>
        <span className={`min-w-0 truncate text-body ${settled ? 'text-fg-muted' : 'text-fg'}`}>{item.prompt}</span>
        {collapsed && state.kind === 'decide' && (
          <>
            <span className="min-w-0 flex-1 truncate font-mono text-meta text-fg-muted" data-testid={`ask-bundle-target-${item.rootId}`}>
              {state.src.line?.cap} {state.src.line?.scope}
            </span>
            <button
              type="button" data-testid={`ask-bundle-expand-${item.rootId}`}
              className="ml-auto shrink-0 rounded-sm px-1 text-meta text-fg-muted underline underline-offset-2 hover:text-fg"
              onClick={onExpand}
            >
              {t('speech.bundle.expandToDecide')}
            </button>
          </>
        )}
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
            type="button" data-testid={`ask-bundle-decline-${item.rootId}`} disabled={!canPick}
            className="rounded-sm px-1 text-meta text-fg-subtle underline underline-offset-2 hover:text-fg-muted disabled:opacity-60"
            onClick={() => onDecline(state.root)}
          >
            {t('speech.ask.decline')}
          </button>
          <button
            type="button" data-testid={`ask-bundle-reply-${item.rootId}`}
            className="ml-auto rounded-sm px-1 text-meta text-fg-subtle underline decoration-dotted underline-offset-2 hover:text-fg-muted"
            onClick={goOriginal}
          >
            {t('speech.bundle.replyInThread')}
          </button>
        </div>
      )}
      {state.kind === 'decide' && !collapsed && (
        <div className="-mx-3 -mb-1" data-testid={`ask-bundle-decide-${item.rootId}`}>
          <MandateLineBody
            message={state.root} src={state.src} canChoose={canDecide}
            optionIds={readAskMeta(state.root.meta)!.options.map((o) => o.id)} answeredWith={null} closedReason={null} supersededBy={null}
            contextText={cardContextText(state.root)}
            decideHere={{
              answer: (optionId) => getController().answerBundleItem(bundle.id, bundle.channelId, item.rootId, optionId),
              once: async (body) => { await getController().api.answerBundleItem(bundle.channelId, bundle.id, item.rootId, 'approve_once', body); return {}; },
              trailing: (
                <button type="button" data-testid={`ask-bundle-original-${item.rootId}`} className="rounded-sm px-1 text-meta text-fg-subtle underline underline-offset-2 hover:text-fg-muted" onClick={goOriginal}>
                  {t('speech.bundle.originalThread')}
                </button>
              ),
            }}
          />
        </div>
      )}
      {state.kind === 'link' && (
        <button type="button" data-testid={`ask-bundle-link-${item.rootId}`} className="mt-1 text-meta text-fg-muted underline underline-offset-2" onClick={goOriginal}>
          {t('speech.bundle.decideInThread')}
        </button>
      )}
      {state.kind === 'loading' && <p className="mt-0.5 text-meta text-fg-subtle">{t('speech.bundle.loading')}</p>}
      {state.kind === 'unavailable' && <p className="mt-0.5 text-meta text-fg-subtle">{t('speech.bundle.unavailable')}</p>}
      {state.kind === 'answered' && <AnsweredLine state={state} name={nameOf(accounts, state.by, t)} t={t} />}
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
      {state.kind === 'expired' && <p className="mt-0.5 text-meta text-fg-subtle">{t('speech.ask.expired')} · {t('speech.ask.expiredHint')}</p>}
      {state.kind === 'declined' && <p className="mt-0.5 text-meta text-fg-subtle">{t('speech.ask.declined')}</p>}
      {error && <p role="alert" data-testid={`ask-bundle-error-${item.rootId}`} className="mt-0.5 text-meta text-danger">{error}</p>}
      {result && result.outcome !== 'answered' && result.outcome !== 'resolved' && (
        <p data-testid={`ask-bundle-skip-${item.rootId}`} data-outcome={result.outcome} className="mt-0.5 text-meta text-fg-muted">
          {t(`speech.bundle.skip.${result.outcome}`)}
        </p>
      )}
    </li>
  );
}

/** 끝난 줄 한 줄. 권한 줄은 결과 낱말 뒤에 대상 앞부분을 남긴다 — 무엇에 허락했는지 다시 펼치지 않고 읽게. */
function AnsweredLine({ state, name, t }: { state: Extract<RowState, { kind: 'answered' }>; name: string; t: Translate }) {
  const src = readRootSource(state.root);
  const ask = readAskMeta(state.root.meta);
  const standing = src ? standingResultOf(src.request, ask?.answeredWith ?? null) : null;
  const key = src ? standing?.key ?? elsewhereResult(lineResultKey(ask?.answeredWith ?? null), true) : null;
  if (!src?.line || !key) {
    return <p className="mt-0.5 text-meta text-fg-subtle">{t('speech.bundle.answered', { label: state.label ?? '—', name })}</p>;
  }
  const ghUser = (state.root.meta.permissionRequest as { ghUserUsed?: unknown } | undefined)?.ghUserUsed;
  return (
    <p className="mt-0.5 truncate text-meta text-fg-subtle" data-testid="ask-bundle-result">
      {ask?.answeredWith !== 'deny' && '✓ '}{t(key, { who: name, date: standing?.date ?? '' })}
      {typeof ghUser === 'string' && ` · gh ${ghUser}`}
      <span className="ml-1.5 font-mono">{src.line.cap} {src.line.scope}</span>
    </p>
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
