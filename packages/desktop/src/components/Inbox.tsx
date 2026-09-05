import { useCallback, useEffect, useMemo, useState } from 'react';
import { Overlay } from './Overlay';
import type { InboxEntry } from '@murmur/shared';
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

/** '전체'는 필터가 꺼진 상태다. 나머지 셋은 `InboxEntry['reason']` 과 같은 값이어야 한다. */
type ReasonFilter = 'all' | InboxEntry['reason'];

const REASON_LABEL: Record<InboxEntry['reason'], string> = {
  mention: '멘션',
  thread_reply: '스레드 답글',
  dm: 'DM',
};

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
  const messages = useActiveStore((s) => s.messages);

  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [reason, setReason] = useState<ReasonFilter>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
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
    setReason('all');
    setUnreadOnly(false);
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

  /** 필터 드롭다운에 낼 채널들. 지금 목록에 실제로 등장하는 채널만 낸다. */
  const channelOptions = useMemo(() => {
    const ids = new Set<string>(entries.map((e) => e.channelId));
    for (const d of draftItems) if (d.channelId) ids.add(d.channelId);
    return [...ids].map((id) => ({ id, label: channelLabel(id) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [entries, draftItems, channelLabel]);

  const shownEntries = useMemo(() => entries.filter((e) => {
    if (reason !== 'all' && e.reason !== reason) return false;
    if (unreadOnly && e.readAt !== null) return false;
    if (channelFilter !== 'all' && e.channelId !== channelFilter) return false;
    return true;
  }), [entries, reason, unreadOnly, channelFilter]);

  const shownDrafts = useMemo(() => draftItems.filter((d) => {
    // 종류로 좁히면 초안은 빠진다. 초안은 멘션도 답글도 DM 도 아니다 — 남이 나를 부른 것이
    // 아니라 내가 쓰다 만 것이다. "멘션만" 이라고 물었는데 초안이 남아 있으면 그 목록은
    // 자기가 무엇인지 답하지 못한다. '안 읽음만' 에서는 남는다: 쓰다 만 초안은 언제나
    // 아직 처리하지 않은 것이라 그 물음에 대한 답이 늘 참이다.
    if (reason !== 'all') return false;
    if (channelFilter !== 'all' && d.channelId !== channelFilter) return false;
    return true;
  }), [draftItems, reason, channelFilter]);

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

  const entryRow = (e: InboxEntry) => (
    <li key={e.id}>
      <button
        data-testid={`inbox-entry-${e.id}`}
        onClick={() => openEntry(e)}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-hover"
      >
        <span
          data-testid={`inbox-reason-${e.id}`}
          className="rounded bg-surface-sunken px-1 text-[10px] uppercase tracking-wide text-fg-muted"
        >
          {REASON_LABEL[e.reason]}
        </span>
        <span className="text-fg-muted">{channelLabel(e.channelId)}</span>
        {/* 안 읽음은 표시가 있어야 한다. 필터로 걸러 볼 수 있는 것이 목록에서는 안 보이면
            "안 읽음만" 을 껐을 때 무엇이 안 읽은 것인지 알 수 없다. */}
        {e.readAt === null && (
          <span
            data-testid={`inbox-unread-${e.id}`}
            className="rounded bg-sky-900 px-1 text-[10px] text-sky-200"
          >
            안 읽음
          </span>
        )}
      </button>
    </li>
  );

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
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <label className="flex items-center gap-1">
            <span className="text-xs text-fg-subtle">종류</span>
            <select
              aria-label="종류 필터"
              className="rounded border border-border bg-field px-2 py-1 text-fg"
              value={reason}
              onChange={(e) => setReason(e.target.value as ReasonFilter)}
            >
              <option value="all">전체</option>
              <option value="mention">{REASON_LABEL.mention}</option>
              <option value="thread_reply">{REASON_LABEL.thread_reply}</option>
              <option value="dm">{REASON_LABEL.dm}</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            <span className="text-xs text-fg-subtle">채널</span>
            <select
              aria-label="채널 필터"
              className="rounded border border-border bg-field px-2 py-1 text-fg"
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
            >
              <option value="all">전체</option>
              {channelOptions.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              aria-label="안 읽음만"
              checked={unreadOnly}
              onChange={(e) => setUnreadOnly(e.target.checked)}
            />
            <span className="text-xs text-fg-muted">안 읽음만</span>
          </label>
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
