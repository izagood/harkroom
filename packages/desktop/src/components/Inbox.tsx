import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Identity } from './Identity';
import type { InboxEntry } from '@harkroom/shared';
import { bodyWithHandles } from '../lib/mention';
import { inboxRow } from '../lib/inboxRow';
import { useActiveStore } from '../state/communities';
import { isMentionOrDm } from '../state/unread';
import { getController } from '../state/controller';
import { useAgo, useLocale, useT } from '../i18n/useT';
import { dateTimeText } from '../lib/localeText';

/** 빈 배열 리터럴을 매 렌더 새로 만들지 않는다. */
const INBOX_NO_TEAMS: never[] = [];

interface Props {
  open: boolean;
  onClose: () => void;
}

const THREAD_PREFIX = 'thread:';

/**
 * 인박스 자리 — **안 읽은 멘션·DM 목록** 하나다.
 *
 * 재료는 스토어의 `unread`(`GET /inbox?unread=1`)다. 컨트롤러가 기동·`inbox.updated`·재연결 때 이미 받아
 * 들고 있으므로 이 화면은 따로 조회하지 않는다 — 열려 있는 동안 새로 온 것도 그 배열이 바뀌면 저절로 선다.
 * 줄을 누르면 그 말이 있는 스레드(채널 바로 밑의 말이면 그 말)를 열고, 읽음은 여는 쪽(`controller.openThread`·
 * `openMessage`)이 지금처럼 서버에 올린다.
 *
 * ### 좁은 창
 *
 * 인박스가 Esc 를 document 에서 받으므로 **`⌘\` 를 삼키지 않는 것**이 여기서 지켜야 할 것이고,
 * `inboxPane.test.tsx` 가 그것을 잰다.
 */
export function Inbox({ open, onClose }: Props) {
  const t = useT();
  const ago = useAgo();
  const locale = useLocale();
  const channels = useActiveStore((s) => s.channels);
  const dms = useActiveStore((s) => s.dms);
  const accounts = useActiveStore((s) => s.accounts);
  // 문장의 집합·팀 토큰(#845). 안 주면 그 자리가 `@알 수 없음` 이 된다.
  const groups = useActiveStore((s) => s.groups);
  const teams = useActiveStore((s) => s.teams) ?? INBOX_NO_TEAMS;
  const me = useActiveStore((s) => s.me);
  const drafts = useActiveStore((s) => s.drafts);
  const unread = useActiveStore((s) => s.unread);

  /** 안 읽은 멘션·DM 만, 최근 것부터 — 배지와 같은 판정(`isMentionOrDm`)이라 배지 수와 줄 수가 같다. */
  const rows = useMemo(
    () => unread.filter((e) => !e.readAt && isMentionOrDm(e)).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [unread],
  );

  /** 채널 하나의 사람이 읽을 이름. DM 은 이름이 없으므로 상대 handle 로 짓는다. */
  const channelLabel = useCallback((id: string): string => {
    const ch = channels.find((c) => c.id === id);
    if (ch?.kind === 'standard') return `#${ch.name ?? id}`;
    const dm = dms.find((d) => d.id === id);
    if (dm) {
      const peers = dm.memberIds.filter((p) => p !== me?.id);
      return peers.map((p) => accounts[p]?.handle ?? '…').join(', ') || t('sidebar.dm.justMe');
    }
    return ch?.name ? `#${ch.name}` : id;
  }, [channels, dms, accounts, me, t]);

  /** 쓰다 만 초안. 목록 밖 한 줄이다 — 남이 나를 부른 것이 아니라 내가 쓰다 만 것이다. */
  const draftKeys = useMemo(
    () => Object.entries(drafts).filter(([, body]) => body.trim().length > 0).map(([k]) => k),
    [drafts],
  );

  /** 이 자리의 뿌리. 열 때 포커스를 옮기는 곳이다. */
  const paneRef = useRef<HTMLElement | null>(null);

  /**
   * **Esc 로 접는다.** document 리스너인 이유: 옆의 채널·스레드를 읽는 동안 포커스는 늘
   * 인박스 밖에 있다. **오버레이가 떠 있으면 Esc 는 내 것이 아니다** — 자리는 늘 오버레이
   * 아래에 있다. `⌘\` 는 삼키지 않는다(좁은 창에서 빠져나오는 길이다, `inboxPane.test.tsx`).
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  /** **열면 포커스가 이 자리로 들어온다**(모달의 포커스 트랩 대신). */
  useEffect(() => {
    if (!open) return;
    paneRef.current?.focus({ preventScroll: true });
  }, [open]);

  if (!open) return null;

  /**
   * 줄을 연다. **스레드 안의 말이면 오른쪽 패널로 열고 목록은 남는다.** 채널 바로 밑의 말이면 목적지가
   * 본문이라 목록이 자리를 내준다. 읽음은 여는 쪽이 서버에 올리고, 스토어의 `unread` 가 다시 받혀 줄이 걷힌다.
   */
  const openEntry = (entry: InboxEntry): void => {
    if (entry.threadRootId) {
      void getController().openThread(entry.threadRootId, { channelId: entry.channelId });
      return;
    }
    onClose();
    void getController().openMessage(entry.messageId);
  };

  return (
    <aside
      ref={paneRef}
      data-testid="inbox-pane"
      // `<aside>` 가 랜드마크(`complementary`)다. `tabIndex={-1}`: 스크립트로만 포커스를 받는다.
      // 폭은 본문 열 그대로(`flex-1`), `min-w-0` 이 없으면 긴 줄이 오른쪽 패널을 밀어낸다.
      tabIndex={-1}
      aria-label={t('inbox.pane.title')}
      className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface-sunken
                 text-fg outline-none focus-visible:outline-solid focus-visible:outline-2
                 focus-visible:outline-accent focus-visible:-outline-offset-2"
    >
      <div className="flex items-center gap-2 border-b border-border bg-surface-raised p-3">
        <span className="font-semibold">{t('inbox.pane.title')}</span>
        {rows.length > 0 && (
          <span data-testid="inbox-unread-count" className="text-meta text-fg-subtle">{rows.length}</span>
        )}
        <button
          onClick={onClose}
          className="ml-auto rounded-row px-2 py-1 text-fg-muted hover:bg-surface-hover
                     focus-visible:outline-solid focus-visible:outline-2
                     focus-visible:outline-accent"
          aria-label={t('inbox.pane.close')}
        >
          ✕
        </button>
      </div>
      {rows.length === 0 ? (
        <p data-testid="inbox-empty" className="p-3 text-fg-subtle">{t('inbox.list.empty')}</p>
      ) : (
        <ul data-testid="inbox-list" className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
          {rows.map((entry) => {
            const who = entry.authorId && entry.kind !== 'system' ? accounts[entry.authorId] : undefined;
            const row = inboxRow(entry, me?.id ?? null, t);
            return (
              <li key={entry.id} className="rounded-row border border-border bg-surface-raised">
                <button
                  data-testid={`inbox-row-${entry.id}`}
                  onClick={() => openEntry(entry)}
                  className="flex w-full flex-col gap-1 rounded-row border-l-2 border-accent px-2 py-1.5 text-left hover:bg-surface-hover"
                >
                  <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-meta text-fg-subtle">
                    {who && <Identity account={who} className="h-5 w-5 shrink-0 text-[10px]" variant="avatar" />}
                    {who && <span aria-hidden="true" className="shrink-0 font-medium text-fg-muted">{who.handle}</span>}
                    <span data-testid={`inbox-row-label-${entry.id}`} className="shrink-0 text-accent">{row.label}</span>
                    <span data-testid={`inbox-row-channel-${entry.id}`} className="min-w-[3ch] truncate">{channelLabel(entry.channelId)}</span>
                    <span className="shrink-0" title={dateTimeText(entry.createdAt, locale)}>
                      · {ago(new Date(entry.createdAt).getTime())}
                    </span>
                  </span>
                  <span data-testid={`inbox-row-body-${entry.id}`} className="line-clamp-2 break-words text-fg">
                    {bodyWithHandles(entry.body, accounts, groups, teams)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {/* 쓰다 만 초안 — 목록 밖 한 줄. 누르면 가장 최근 초안 자리로 간다. */}
      {draftKeys.length > 0 && (
        <button
          data-testid="inbox-drafts"
          onClick={() => {
            const key = draftKeys[0]!;
            if (key.startsWith(THREAD_PREFIX)) { void getController().openMessage(key.slice(THREAD_PREFIX.length)); return; }
            onClose();
            void getController().openChannel(key);
          }}
          className="mt-auto border-t border-border bg-surface-raised px-3 py-2 text-left text-meta text-fg-muted hover:bg-surface-hover"
        >
          {t('inbox.board.drafts', { count: draftKeys.length })}
        </button>
      )}
    </aside>
  );
}
