import { useCallback, useEffect, useMemo, useState } from 'react';
import { Overlay } from './Overlay';
import { Identity } from './Identity';
import { WaitChainSection } from './WaitChainSection';
import type { InboxEntry } from '@murmur/shared';
import { inboxRow, matchesFilter, type InboxFilter } from '../lib/inboxRow';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * 조회 상태를 셋으로 나눈다(#226 의 Directory 와 같은 모양). 둘로 두면 **"못 불러왔다"가
 * "아무도 안 불렀다"로 보인다** — inbox 에서는 그 거짓말의 값이 특히 비싸다. 나를 부른 것이
 * 없다는 화면과 부른 것을 못 물어본 화면은 사람이 다음에 할 일이 정반대다(`design.md` §4).
 */
type LoadState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

// `ReasonFilter`·`REASON_LABEL` 이 여기 있었다(#488 C2 에서 지웠다). `reason` 은 값이
// 셋뿐이라 **무엇을 그려도 네 줄이 갈리지 않았고**, 그것이 문서가 지적한 결함이었다.
// 말의 종류는 이제 `lib/inboxRow` 가 `meta` 에서 읽는다.

const THREAD_PREFIX = 'thread:';

/** 목록에 낼 초안 하나. scopeKey 를 풀어 어디로 갈 것인지까지 담는다. */
interface DraftItem {
  scopeKey: string;
  body: string;
  /** `thread:<rootId>` 초안의 루트 메시지 id. 채널 초안이면 null. */
  threadRootId: string | null;
  /** 채널 필터가 볼 채널. 스레드 초안은 알아내지 못할 수 있어 null 이 된다. */
  channelId: string | null;
}

/**
 * 나를 부른 것을 모아 걸러 보는 표면(#185).
 *
 * **서버 표면을 새로 만들지 않는다** — `GET /inbox` 가 이미 전체를 준다. 필터는 전부
 * 클라이언트에서 한다. 없던 것은 질의 능력이 아니라 목록 자체였다.
 *
 * 스토어의 `unread` 를 읽지 않고 이 화면이 직접 조회하는 이유: 그 배열은 `?unread=1` 로만
 * 채워져 **안 읽은 것밖에 없다.** 그것만 보면 "안 읽음만" 필터가 항상 참이라 아무것도
 * 거르지 않는 스위치가 된다. 배지·알림이 기대는 `unread` 의 뜻은 그대로 두고, 이 화면은
 * 읽은 것까지 포함한 자기 목록을 갖는다.
 *
 * 필터는 **오늘 데이터로 되는 것만** 있다: 종류(`reason`), 안 읽음(`readAt === null`),
 * 채널(`channelId`). 시간·작성자는 없다 — 뷰가 `created_at` 을 안 내려주고 작성자는
 * 엔트리에 없다. 있는 척하는 필터를 두는 것보다 없는 편이 정직하다.
 *
 * 필터 상태는 영속하지 않는다. 닫았다 열면 처음으로 돌아간다 — 좁혀 둔 것을 기억해 두면
 * 다음에 열었을 때 **걸러져 사라진 항목이 없는 항목으로 보인다.**
 */
export function Inbox({ open, onClose }: Props) {
  const channels = useActiveStore((s) => s.channels);
  const dms = useActiveStore((s) => s.dms);
  const accounts = useActiveStore((s) => s.accounts);
  const me = useActiveStore((s) => s.me);
  const drafts = useActiveStore((s) => s.drafts);
  const myId = me?.id ?? null;
  /** 지금 답을 보내는 중인 항목. 두 번 눌러 두 번 보내지 않게 한다. */
  const [answering, setAnswering] = useState<number | null>(null);

  /**
   * **줄에서 바로 답한다**(#488 C2). 스레드를 열지 않는다 — 문서: *"스레드를 열어야만
   * 답할 수 있으면 인박스는 알림 목록일 뿐"* 이다.
   *
   * 답한 뒤 목록을 다시 읽는다: 그 물음은 더 이상 나를 막지 않으므로 줄의 종류와
   * 순서가 함께 바뀐다.
   */
  const answer = async (e: InboxEntry, optionId: string): Promise<void> => {
    setAnswering(e.id);
    try {
      await getController().answerAsk(e.messageId, optionId, e.channelId);
      reload();
    } finally { setAnswering(null); }
  };
  const messages = useActiveStore((s) => s.messages);

  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  /**
   * **칩 하나가 정렬 축을 그대로 쓴다**(#488 C2·B3). 네이티브 `select` 둘과 체크박스가
   * 사라진 자리다 — 고르는 축과 보이는 순서가 어긋나지 않는다.
   */
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [channelFilter, setChannelFilter] = useState('all');

  const reload = useCallback((): (() => void) => {
    let alive = true;
    setLoad({ kind: 'loading' });
    getController().api.inbox().then(
      (rows) => { if (alive) { setEntries(rows); setLoad({ kind: 'ready' }); } },
      (err: unknown) => {
        if (!alive) return;
        // 실패했을 때 앞선 결과를 남겨 두면 낡은 목록이 지금 사실인 척한다. 비우고,
        // 비었다는 말 대신 오류를 보여 준다.
        setEntries([]);
        setLoad({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    setFilter('all');
    setChannelFilter('all');
    return reload();
  }, [open, reload]);

  /** 채널 하나의 사람이 읽을 이름. DM 은 이름이 없으므로 상대 handle 로 짓는다. */
  const channelLabel = useCallback((id: string): string => {
    const ch = channels.find((c) => c.id === id);
    if (ch?.kind === 'standard') return `#${ch.name ?? id}`;
    const dm = dms.find((d) => d.id === id);
    if (dm) {
      const peers = dm.memberIds.filter((p) => p !== me?.id);
      return peers.map((p) => accounts[p]?.handle ?? '…').join(', ') || 'just me';
    }
    return ch?.name ? `#${ch.name}` : id;
  }, [channels, dms, accounts, me]);

  const draftItems = useMemo<DraftItem[]>(() => Object.entries(drafts)
    // **내용이 비어 있지 않은 것만** 항목이 된다. `setDraft` 가 빈 문자열은 지우지만
    // 공백만 남은 초안은 truthy 라 살아남는다 — 그것은 쓰다 만 답글이 아니라 흔적이다.
    .filter(([, body]) => body.trim().length > 0)
    .map(([scopeKey, body]) => {
      const isThread = scopeKey.startsWith(THREAD_PREFIX);
      const threadRootId = isThread ? scopeKey.slice(THREAD_PREFIX.length) : null;
      // 스레드 초안의 채널은 scopeKey 에 없다. 이미 받아 둔 메시지에서 루트를 찾아본다 —
      // 채널 필터가 초안에도 정직하게 걸리게 하려면 이것이 필요하다. 못 찾으면 null 로
      // 두고, 특정 채널로 좁혔을 때는 내보내지 않는다(좁힌다는 것은 확실한 것만 남긴다는 뜻).
      const channelId = isThread
        ? Object.keys(messages).find((cid) =>
            (messages[cid] ?? []).some((m) => m.id === threadRootId)) ?? null
        : scopeKey;
      return { scopeKey, body, threadRootId, channelId };
    }), [drafts, messages]);

  /**
   * **정렬은 막는 순이다**(#488 C2). 문서: *"시간순이 아니라 나를 막는 것 → 읽을 것 →
   * 배경. 필터 칩이 그 순서를 그대로 쓴다."*
   *
   * 시간은 `rank` 가 같을 때만 본다 — 그 안에서는 **최근이 위**다. 시간을 첫 축으로
   * 두면 방금 온 답글 하나가 어제부터 나를 막고 있던 물음을 아래로 밀어낸다.
   */
  const shownEntries = useMemo(() => entries
    .map((e) => ({ e, row: inboxRow(e, myId) }))
    .filter(({ e, row }) => {
      if (!matchesFilter(row, filter)) return false;
      if (channelFilter !== 'all' && e.channelId !== channelFilter) return false;
      return true;
    })
    .sort((a, b) => a.row.rank - b.row.rank
      || Date.parse(b.e.createdAt) - Date.parse(a.e.createdAt))
    .map(({ e }) => e),
  [entries, filter, channelFilter, myId]);

  const shownDrafts = useMemo(() => draftItems.filter((d) => {
    // **칩으로 좁히면 초안은 빠진다.** 초안은 남이 나를 부른 것이 아니라 내가 쓰다 만
    // 것이라 '나를 막는 것'도 '읽을 것'도 아니다. "막는 것만" 이라고 물었는데 초안이
    // 남아 있으면 그 목록은 자기가 무엇인지 답하지 못한다.
    if (filter !== 'all') return false;
    if (channelFilter !== 'all' && d.channelId !== channelFilter) return false;
    return true;
  }), [draftItems, filter, channelFilter]);

  if (!open) return null;

  const openEntry = (e: InboxEntry): void => {
    // #178·#228 이 이미 만든 이동 경로다. 채널을 열고, 답글이면 스레드까지 열고, 강조를
    // 건다. 실패도 그 안에서 사람에게 보인다.
    void getController().openMessage(e.messageId);
    onClose();
  };

  const openDraft = (d: DraftItem): void => {
    // 스레드 초안의 scopeKey 에 든 rootId 는 **메시지 id 다.** 그래서 채널을 몰라도
    // openMessage 가 알아서 채널을 열고 스레드를 편다 — 새 이동 경로를 만들 이유가 없다.
    if (d.threadRootId) void getController().openMessage(d.threadRootId);
    else void getController().openChannel(d.scopeKey);
    onClose();
  };

  /**
   * 인박스 줄 하나 — **네 가지를 말한다**(#488 C2): 누가(얼굴) · 무슨 말 · 무엇을(본문
   * 한 줄) · 언제·어디.
   *
   * 전에는 `[스레드 답글] #general` 뿐이라 **네 줄이 글자까지 똑같았다.** 그 셋은
   * "어떻게 나에게 왔는가"를 말하지 "무슨 말인가"를 말하지 않는다 — 종류는 `meta` 가
   * 답하고(`lib/inboxRow`), 나머지 재료는 서버가 실어 준다.
   */
  const entryRow = (e: InboxEntry) => {
    const row = inboxRow(e, myId);
    return (
    <li key={e.id}>
      <button
        data-testid={`inbox-entry-${e.id}`}
        data-kind={row.kind}
        data-rank={row.rank}
        onClick={() => openEntry(e)}
        className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-hover"
      >
        {/* **누가** — 얼굴이 이름을 대신한다(identity 문서와 같은 규칙). */}
        {e.authorId && (
          <Identity account={accounts[e.authorId]} className="mt-0.5 h-5 w-5 text-[10px]" variant="avatar" />
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            {/*
              **무슨 말.** 나를 막는 것만 강조를 받는다(규칙 04) — 강조가 여러 줄에
              뿌려지면 "내 차례"라는 신호가 죽고, 인박스는 그 신호가 가장 진해야 하는
              자리다.
            */}
            <span
              data-testid={`inbox-reason-${e.id}`}
              className={`rounded px-1 text-[10px] ${row.rank === 0
                ? 'bg-accent-surface font-medium text-state-turn'
                : 'bg-surface-sunken text-fg-muted'}`}
            >
              {row.label}
            </span>
            {/* **무엇을** — 본문 한 줄. 자르는 폭은 화면이 정한다(서버는 안 자른다). */}
            <span className="truncate text-fg">{e.body}</span>
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
            {/* **언제·어디.** */}
            <span>{channelLabel(e.channelId)}</span>
            {e.threadRootId && <span>· 스레드</span>}
            <span>· {new Date(e.createdAt).toLocaleString()}</span>
        {/* 안 읽음은 표시가 있어야 한다. 필터로 걸러 볼 수 있는 것이 목록에서는 안 보이면
            "안 읽음만" 을 껐을 때 무엇이 안 읽은 것인지 알 수 없다. */}
            {e.readAt === null && (
              <span data-testid={`inbox-unread-${e.id}`} className="text-accent">· 안 읽음</span>
            )}
          </span>
        </span>
      </button>
      {/*
        **선택은 줄에서 끝난다**(문서). *"선택지가 둘뿐이면 인박스에서 바로 누른다.
        스레드를 열어야만 답할 수 있으면 인박스는 알림 목록일 뿐이고, 컨셉이 말한
        '막는 말을 푸는 자리'가 되지 못한다."*

        버튼을 줄 **바깥**에 두는 이유: 안에 넣으면 `<button>` 안의 `<button>` 이 되어
        HTML 이 허용하지 않고, 고르려다 스레드가 열린다.
      */}
      {row.options && (
        <div className="flex gap-1 px-2 pb-1.5 pl-9">
          {row.options.map((o) => (
            <button
              key={o.id}
              data-testid={`inbox-answer-${e.id}-${o.id}`}
              disabled={answering === e.id}
              onClick={() => void answer(e, o.id)}
              className="rounded border border-border px-2 py-0.5 text-[11px] text-fg
                         hover:bg-surface-hover disabled:opacity-50"
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </li>
    );
  };

  const draftRow = (d: DraftItem) => (
    <li key={d.scopeKey}>
      <button
        data-testid={`inbox-draft-${d.scopeKey}`}
        onClick={() => openDraft(d)}
        className="flex w-full items-center gap-2 rounded border-l-2 border-warning-border px-2 py-1.5 text-left hover:bg-surface-hover"
      >
        {/* 초안은 inbox 항목과 **눈으로 구분돼야 한다.** 하나는 남이 나를 부른 것이고
            하나는 내가 쓰다 만 것이다. 섞이면 목록이 무엇을 말하는지 알 수 없다.
            색만으로는 부족해 글자 표를 함께 단다. */}
        <span
          data-testid={`inbox-draft-badge-${d.scopeKey}`}
          className="rounded bg-warning-surface px-1 text-[10px] uppercase tracking-wide text-warning"
        >
          초안
        </span>
        <span className="text-fg-muted">
          {d.channelId ? channelLabel(d.channelId) : d.threadRootId ? '스레드' : d.scopeKey}
        </span>
        <span className="truncate text-fg-subtle">{d.body}</span>
      </button>
    </li>
  );

  return (
    <Overlay label="인박스" onClose={onClose}>
        <div className="flex items-center gap-2 border-b border-border p-3">
          <span className="font-bold">Inbox</span>
          <button
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-fg-muted hover:bg-surface-hover"
            aria-label="인박스 닫기"
          >
            ✕
          </button>
        </div>
        {/*
          **필터 칩이 정렬 순서를 그대로 쓴다**(#488 C2). 네이티브 `select` 둘과
          체크박스가 사라진 자리다(B3) — 고르는 축과 보이는 순서가 어긋나지 않는다.
        */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border p-3">
          {([
            ['blocking', '나를 막는 것'],
            ['reading', '읽을 것'],
            ['all', '전부'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              data-testid={`inbox-filter-${value}`}
              data-selected={filter === value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${filter === value
                ? 'border-border bg-surface-sunken font-medium text-fg'
                : 'border-border text-fg-muted hover:bg-surface-hover'}`}
            >
              {label}
              {value !== 'all' && (
                <span className="ml-1 text-fg-subtle">
                  {entries.filter((e) => matchesFilter(inboxRow(e, myId), value)).length}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {/* 실패는 목록 위에 남긴다. 실패했는데 빈 목록만 보이면 사람은 "아무도 나를
              부르지 않았다" 로 읽는다 — 조회 실패를 빈 목록으로 삼키지 않는다. */}
          {load.kind === 'error' && (
            <div role="alert" className="mb-3 rounded border border-danger-border bg-danger-surface p-2 text-xs text-danger">
              인박스를 불러오지 못했다 — {load.message}
              <button
                onClick={() => { reload(); }}
                className="ml-2 rounded bg-danger px-2 py-0.5 text-fg-on-strong hover:bg-danger-hover"
              >
                다시 시도
              </button>
            </div>
          )}
          {load.kind === 'loading' && <p className="px-2 text-xs text-fg-subtle">불러오는 중…</p>}

          <section aria-label="나를 부른 것" className="mb-4">
            <h3 className="px-2 pb-1 text-[11px] uppercase tracking-wide text-fg-subtle">
              나를 부른 것 ({shownEntries.length})
            </h3>
            {/* '없다' 는 조회가 성공했을 때만 말할 수 있다. 실패·대기 중에 이 문장을 내면
                모르는 것을 아는 것처럼 말하는 것이다. */}
            {load.kind === 'ready' && shownEntries.length === 0 && (
              <p data-testid="inbox-empty" className="px-2 text-xs text-fg-subtle">
                {entries.length === 0 ? '나를 부른 것이 없다' : '필터에 맞는 것이 없다'}
              </p>
            )}
            {shownEntries.length > 0 && <ul>{shownEntries.map(entryRow)}</ul>}
          </section>

          {/* 초안은 나란한 **별도 구획**이다. 하나는 서버 진실이고 하나는 로컬 상태라
              정렬 기준(시간)을 공유하지 않는다 — 한 목록에 섞으면 순서가 거짓말이 된다. */}
          {/*
            **나에게 오지 않았지만 무언가를 멈추고 있는 것**(#488 A3-b). 위 구획은
            나를 부른 것만 담으므로 `codex → forge → alpha` 처럼 나와 무관하게 얽힌
            사슬은 어디에도 안 보인다 — 인박스가 "막는 말이 모이는 자리"이려면 그것도
            여기 있어야 한다.
          */}
          <section aria-label="기다리는 것" className="mb-4">
            <WaitChainSection />
          </section>

          <section aria-label="쓰다 만 초안">
            <h3 className="px-2 pb-1 text-[11px] uppercase tracking-wide text-fg-subtle">
              쓰다 만 초안 ({shownDrafts.length})
            </h3>
            {shownDrafts.length === 0
              ? <p className="px-2 text-xs text-fg-subtle">쓰다 만 초안이 없다</p>
              : <ul>{shownDrafts.map(draftRow)}</ul>}
          </section>
        </div>
    </Overlay>
  );
}
