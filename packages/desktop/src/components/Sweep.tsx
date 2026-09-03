import { useCallback, useEffect, useState } from 'react';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import type { SweepItem } from '../state/sweep';

/**
 * 훑기 화면(#227) — 미읽음을 하나씩 보여 주고 다음으로 넘어간다.
 *
 * **동작과 모드를 나눠 둔다.** `SweepShell` 은 `SweepItem[]` 만 알고, 무엇을 훑을지는
 * 바깥이 정한다. 이번에 만든 모드는 `Sweep` 하나(전체 미읽음)뿐이고, #185("나를 부른 것")는
 * `InboxEntry[]` 라는 다른 데이터 모델에서 목록을 만들어 같은 shell 에 끼우면 된다 —
 * 같은 자리를 두 번 만들지 않기 위해서다.
 */
export function SweepShell({ items, loading, error, onRetry, onClose, onMarkRead }: {
  items: SweepItem[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
  onMarkRead: (item: SweepItem) => Promise<void>;
}) {
  const [index, setIndex] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const accounts = useActiveStore((s) => s.accounts);

  /**
   * 목록을 다시 불러오면 처음부터 본다. 인덱스를 그대로 두면 짧아진 목록의 끝을 가리켜
   * 볼 것이 남았는데도 "다 봤다"가 뜬다.
   *
   * **effect 가 아니라 렌더 중에 되돌린다.** `useEffect(..., [items])` 로 두면 목록이
   * 그려진 뒤 effect 가 흘러나가기 전에 사람이 '다음'을 누를 수 있고, 그 클릭으로 올라간
   * 인덱스를 뒤늦게 도착한 effect 가 0 으로 되돌린다 — 눌렀는데 첫 항목에 머무는 것으로
   * 보인다. CI 에서 `unreadSweep` 두 건이 그렇게 빨개졌다(#227 회귀선). 렌더 중에
   * 이전 값과 비교해 되돌리면 그 창이 없다.
   */
  const [seenItems, setSeenItems] = useState(items);
  if (seenItems !== items) {
    setSeenItems(items);
    setIndex(0);
    setActionError(null);
  }

  const current = items[index];

  /**
   * '읽음 처리하고 다음'. 서버 ack 가 **성공한 뒤에만** 넘어간다 — 실패했는데 넘어가면
   * 사람은 정리했다고 믿지만 미읽음은 그대로 남는다.
   */
  const markAndNext = useCallback(async () => {
    if (!current) return;
    try {
      await onMarkRead(current);
      setActionError(null);
      setIndex((i) => i + 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '읽음 처리에 실패했다');
    }
  }, [current, onMarkRead]);

  /**
   * '그냥 다음'. **읽음 상태를 건드리지 않는다.**
   *
   * 훑으면서 지나가는 것은 읽은 것이 아니다. 그리고 `markChannelRead` 는 단조 전진이라
   * (`readPositions.ts`: "되돌아가지 않고") 실수로 넘긴 항목은 #154 의 미읽음 표시로만
   * 되돌릴 수 있다 — 사람이 모르는 사이에 그 대가를 치르게 하지 않는다.
   */
  const skip = useCallback(() => {
    setActionError(null);
    setIndex((i) => i + 1);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-20"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-xl flex-col rounded-lg border border-border bg-surface-raised shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label="미읽음 훑기"
      >
        <div className="flex items-center gap-2 border-b border-border p-3 text-sm text-fg">
          <span className="font-medium">미읽음 훑기</span>
          {!loading && !error && items.length > 0 && index < items.length && (
            <span className="text-xs text-fg-subtle">{index + 1} / {items.length}</span>
          )}
          <button className="ml-auto rounded px-2 py-0.5 text-xs text-fg-muted hover:bg-surface-hover"
            onClick={onClose}>닫기</button>
        </div>

        {loading && <div className="p-4 text-sm text-fg-muted">불러오는 중…</div>}

        {/* 못 불러온 것과 볼 것이 없는 것은 **다른 상태다.** 조회 실패를 빈 목록으로 삼키면
            화면이 "다 봤다"고 말하게 되고, 그것은 거짓말이다(docs/design.md §4). 그래서
            오류일 때는 완료 문구를 그리는 분기 자체에 닿지 않는다. */}
        {!loading && error && (
          <div className="p-4">
            <p role="alert" className="text-sm text-danger">미읽음을 불러오지 못했다: {error}</p>
            <button className="mt-2 rounded bg-accent px-2 py-1 text-xs text-fg-on-strong hover:bg-accent-hover"
              onClick={onRetry}>다시 시도</button>
          </div>
        )}

        {!loading && !error && !current && (
          <div className="p-6 text-center text-sm text-fg-muted">다 봤다</div>
        )}

        {!loading && !error && current && (
          <>
            <div className="flex-1 overflow-y-auto p-3">
              <div className="mb-2 text-xs text-fg-muted">
                {current.label}
                <span className="ml-2 text-fg-subtle">안 읽은 메시지 {current.messages.length}개</span>
              </div>
              <ul className="space-y-2">
                {current.messages.map((m) => (
                  <li key={m.id} className="rounded bg-surface-sunken p-2 text-sm text-fg">
                    <span className="mr-2 text-xs text-fg-subtle">@{accounts[m.authorId]?.handle ?? m.authorId}</span>
                    {m.body}
                  </li>
                ))}
              </ul>
            </div>
            {actionError && (
              <p role="alert" className="px-3 pb-2 text-xs text-danger">{actionError}</p>
            )}
            <div className="flex gap-2 border-t border-border p-3">
              <button className="rounded bg-accent px-2 py-1 text-xs text-fg-on-strong hover:bg-accent-hover"
                onClick={() => void markAndNext()}>읽음 처리하고 다음</button>
              <button className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover"
                onClick={skip}>그냥 다음</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 전체 미읽음 모드. 목록만 만들고 훑기 동작은 `SweepShell` 에 맡긴다. */
export function Sweep({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [items, setItems] = useState<SweepItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await getController().loadUnreadSweep());
    } catch (err) {
      // 실패했으면 이전 목록도 버린다 — 남겨 두면 오류 문구 옆에 낡은 목록이 함께 보인다.
      setItems([]);
      setError(err instanceof Error ? err.message : '알 수 없는 오류');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (open) void load(); }, [open, load]);

  if (!open) return null;
  return (
    <SweepShell
      items={items}
      loading={loading}
      error={error}
      onRetry={() => void load()}
      onClose={onClose}
      onMarkRead={(item) => getController().markChannelReadUpTo(item.channelId, item.newestSeq)}
    />
  );
}
