/**
 * 스레드 머리의 모델 줄(결정 1·A, 10). 이 스레드에 나온 에이전트마다 칩 하나다.
 *
 * **지정이 하나도 없으면 줄을 세우지 않는다**(결정 10) — 머리줄의 `모델 · 모두 기본` 칩 하나로
 * 접고, 누르면 이 줄이 열린다. 대부분의 스레드는 기본값으로 돌고, 그 스레드마다 칩 줄이 서면
 * 사람은 그 줄을 읽지 않게 된다.
 *
 * 누가 나왔나: 스레드 글의 작성자 중 에이전트 + 본문이 부른 에이전트(`<@id>` 토큰) + 지정이
 * 있는 에이전트. 지정이 있는데 스레드에 안 보이는 에이전트도 빼지 않는다 — 값이 걸려 있다.
 */
import { useMemo } from 'react';
import { MENTION_TOKEN_PATTERN, type MessageRow } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { AgentModelChip } from './AgentModelChip';
import { setByAgentHandle, threadRowFor } from '../lib/threadModels';
import { useT } from '../i18n/useT';

export function threadAgentIds(thread: readonly MessageRow[], isAgent: (id: string) => boolean, setIds: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const m of thread) {
    if (isAgent(m.authorId)) seen.add(m.authorId);
    for (const hit of m.body.matchAll(new RegExp(MENTION_TOKEN_PATTERN, 'g'))) if (isAgent(hit[1]!)) seen.add(hit[1]!);
  }
  for (const id of setIds) seen.add(id);
  return [...seen];
}

/** 머리줄에 접힌 칩. 지정이 있으면 그리지 않는다(그때는 줄이 늘 서 있다). */
export function ThreadModelCollapsed({ rootId, expanded, onToggle }: {
  rootId: string; expanded: boolean; onToggle: () => void;
}) {
  const t = useT();
  const rows = useActiveStore((s) => s.threadAgentModels[rootId]);
  // 아직 못 받았거나 지정이 있으면 접힌 칩이 없다.
  if (!rows || rows.length > 0) return null;
  return (
    <button
      type="button"
      data-testid="thread-models-collapsed"
      aria-expanded={expanded}
      onClick={onToggle}
      className="rounded border border-dashed border-border px-1.5 py-0.5 text-meta text-fg-subtle hover:bg-surface-sunken"
    >
      {t('threadModel.allDefault')}
    </button>
  );
}

export function ThreadModelRow({ channelId, rootId, thread, expanded }: {
  channelId: string; rootId: string; thread: readonly MessageRow[]; expanded: boolean;
}) {
  const t = useT();
  const rows = useActiveStore((s) => s.threadAgentModels[rootId]);
  const accounts = useActiveStore((s) => s.accounts);
  const agentIds = useMemo(
    () => threadAgentIds(thread, (id) => accounts[id]?.kind === 'agent', (rows ?? []).map((r) => r.agentId)),
    [thread, accounts, rows],
  );
  if (!rows) return null;
  if (rows.length === 0 && !expanded) return null;
  if (agentIds.length === 0) return null;

  return (
    <div data-testid="thread-models" className="border-b border-border px-4 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-meta text-fg-muted">{t('threadModel.rowLabel')}</span>
        {agentIds.map((id) => {
          const row = threadRowFor(rows, id);
          const handle = accounts[id]?.handle ?? id.slice(0, 8);
          return (
            <AgentModelChip
              key={id}
              agentId={id}
              handle={handle}
              value={row}
              stale={row?.stale ?? false}
              setByAgent={setByAgentHandle(row, accounts)}
              mode="thread"
              onApply={(v) => getController().setThreadAgentModel(channelId, rootId, id, v.model, v.effort)}
              onReset={() => getController().setThreadAgentModel(channelId, rootId, id, null, null)}
            />
          );
        })}
      </div>
      {/* 무효는 실패가 아니다 — 경고 색으로, 왜(하네스가 무엇으로 바뀌었나)와 할 일([다시 고르기])을
          함께 둔다(designer 검토 3). 다시 고르기는 그 에이전트의 칩을 연다 — 고르개는 지금 하네스의
          목록을 보이므로 거기서 고르면 행이 새 하네스로 다시 적힌다. */}
      {rows.filter((r) => r.stale).map((r) => (
        <p key={r.agentId} role="note" data-testid="thread-models-stale"
          className="mt-1 flex flex-wrap items-center gap-2 rounded border border-warning-border bg-warning-surface px-2 py-1 text-meta text-warning">
          <span>@{accounts[r.agentId]?.handle ?? ''} — {t('threadModel.staleDetail', { harness: r.currentHarness })}</span>
          <AgentModelChip
            agentId={r.agentId}
            handle={accounts[r.agentId]?.handle ?? ''}
            value={null}
            mode="thread"
            trigger={t('threadModel.repick')}
            onApply={(v) => getController().setThreadAgentModel(channelId, rootId, r.agentId, v.model, v.effort)}
            onReset={() => getController().setThreadAgentModel(channelId, rootId, r.agentId, null, null)}
          />
        </p>
      ))}
    </div>
  );
}
