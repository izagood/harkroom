import { useState } from 'react';
import { MAX_CORE_MEMORY_LENGTH, MAX_MEMORY_DESCRIPTION_LENGTH, MAX_MEMORY_VALUE_LENGTH } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { ApiError } from '../../lib/api';
import { agoLabel } from '../../lib/time';
import { useT, useLocale } from '../../i18n/useT';
import type { Translate } from '../../i18n';
import type { MemoryEntry, MemoryRevision } from '../../lib/memoryList';

type Kind = 'topic' | 'procedure' | 'journal';
const KINDS: Kind[] = ['topic', 'procedure', 'journal'];

/** 종류 이름. 키를 글자 조합으로 만들지 않는다 — 카탈로그의 키 검사가 닿게. */
export function kindLabel(t: Translate, k: Kind): string {
  return k === 'journal' ? t('agents.memory.kindJournal')
    : k === 'procedure' ? t('agents.memory.kindProcedure')
      : t('agents.memory.kindTopic');
}

/**
 * 펼친 기억 하나(메모리 고도화 M5). 전에는 본문을 `<pre>` 로 보여 주고 끝이었다 — 에이전트가
 * 틀리게 적은 것을 사람이 바로잡을 길이 **지우는 것밖에** 없었다.
 *
 * - 본문·요약·종류를 고친다. 저장은 **화면이 연 판**(`updatedAt`)을 함께 보낸다 — 그 사이
 *   에이전트가 고쳤으면 서버가 409 로 돌려보내고, 화면은 덮지 않고 "다시 불러와라"를 말한다.
 * - 이전 판(서버가 slug 마다 5개 남긴다)을 펼쳐 보고, 한 판으로 **되돌린다**. 되돌리기도 저장과
 *   같은 길(PUT)이라 되돌린 것 자체가 또 이전 판으로 남는다.
 *
 * `core` 와 목록 줄이 **같은 컴포넌트**를 쓴다 — 두 벌이면 한쪽만 낡는다. core 에는 종류가 없다
 * (매 턴 실리는 자리라 종류로 가르지 않는다).
 */
export function MemoryDetail({ agentId, entry, onChanged }: {
  agentId: string;
  entry: MemoryEntry;
  /** 저장·되돌리기 뒤 목록을 다시 읽게 한다. */
  onChanged: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const isCore = entry.slug === 'core';
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.value);
  const [description, setDescription] = useState(entry.description ?? '');
  const [kind, setKind] = useState<Kind>(entry.kind ?? 'topic');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<MemoryRevision[] | 'error' | null | 'closed'>('closed');
  const limit = isCore ? MAX_CORE_MEMORY_LENGTH : MAX_MEMORY_VALUE_LENGTH;

  const save = (edit: { value: string; description?: string; kind?: Kind }) => {
    setBusy(true);
    setProblem(null);
    void getController().putAgentMemory(agentId, entry.slug, { ...edit, ifUpdatedAt: entry.updatedAt })
      .then(() => { setEditing(false); onChanged(); })
      .catch((err: unknown) => {
        setProblem(err instanceof ApiError && err.status === 409
          ? t('agents.memory.conflict')
          : t('agents.memory.saveFailed'));
      })
      .finally(() => setBusy(false));
  };

  // 쓰기 검사(서버 080)에 걸린 판을 사람이 **확인**한다 — 표시가 풀리고 이 판이 다시 에이전트
  // 프롬프트에 실린다. 고치는 길(편집·되돌리기)은 그대로다: 사람이 쓴 판은 검사하지 않는다.
  const confirmFlag = () => {
    setBusy(true);
    setProblem(null);
    void getController().confirmAgentMemory(agentId, entry.slug)
      .then(() => onChanged())
      .catch(() => setProblem(t('agents.memory.flagConfirmFailed')))
      .finally(() => setBusy(false));
  };

  const openRevisions = () => {
    if (revisions !== 'closed') { setRevisions('closed'); return; }
    setRevisions(null);
    void getController().agentMemoryRevisions(agentId, entry.slug)
      .then(setRevisions)
      .catch(() => setRevisions('error'));
  };

  return (
    <div className="mb-1 space-y-1 px-2" data-testid={`memory-detail-${entry.slug}`}>
      {entry.flaggedAt && (
        <div data-testid="memory-flagged" role="note" className="rounded-row border border-warning-border bg-warning-surface p-2 text-meta">
          <p className="text-warning">{t('agents.memory.flaggedNote', { reason: entry.flagReason ?? '' })}</p>
          <button
            data-testid="memory-flag-confirm"
            className="mt-1 rounded-row border border-border bg-surface px-2 text-meta text-fg disabled:opacity-50"
            disabled={busy}
            onClick={confirmFlag}
          >
            {t('agents.memory.flagConfirm')}
          </button>
        </div>
      )}
      {(entry.readCount !== undefined || entry.description || entry.createdAt) && !editing && (
        <div className="flex flex-wrap gap-x-3 text-meta text-fg-subtle">
          {entry.description && <span data-testid="memory-description">{entry.description}</span>}
          {/* 보관·되살리기도 「고침」 시각을 바꾸므로 만든 때를 따로 보인다(#1186 designer 지침 4). */}
          {entry.createdAt && (
            <span data-testid="memory-created" title={new Date(entry.createdAt).toLocaleString(locale)}>
              {t('agents.memory.created', { ago: agoLabel(new Date(entry.createdAt).getTime(), Date.now(), locale, t) })}
            </span>
          )}
          {entry.readCount !== undefined && (
            <span data-testid="memory-reads">
              {entry.lastReadAt
                ? t('agents.memory.reads', {
                  n: entry.readCount,
                  ago: agoLabel(new Date(entry.lastReadAt).getTime(), Date.now(), locale, t),
                })
                : t('agents.memory.neverRead')}
            </span>
          )}
        </div>
      )}

      {editing ? (
        <div className="space-y-1">
          {/* 서버 PUT 은 보관된 기억을 고치면 되살린다(archived_at=null) — 누르기 전에 말한다. */}
          {entry.archivedAt && (
            <p data-testid="memory-edit-unarchives" className="text-meta text-warning">{t('agents.memory.archivedEditNote')}</p>
          )}
          <textarea
            data-testid="memory-edit-value"
            aria-label={t('agents.memory.editValue')}
            className="h-40 w-full rounded-row border border-border bg-surface p-1 font-mono text-meta"
            value={value}
            maxLength={limit}
            onChange={(e) => setValue(e.target.value)}
          />
          <div className="text-meta text-fg-subtle">
            {t('agents.memory.charsOfMax', { n: value.length.toLocaleString(locale), max: limit.toLocaleString(locale) })}
          </div>
          <input
            data-testid="memory-edit-description"
            aria-label={t('agents.memory.editDescription')}
            placeholder={t('agents.memory.editDescription')}
            className="w-full rounded-sm border border-border bg-surface px-1 text-meta"
            value={description}
            maxLength={MAX_MEMORY_DESCRIPTION_LENGTH}
            onChange={(e) => setDescription(e.target.value)}
          />
          {!isCore && (
            <select
              data-testid="memory-edit-kind"
              aria-label={t('agents.memory.editKind')}
              className="rounded-sm border border-border bg-surface px-1 text-meta"
              value={kind}
              onChange={(e) => setKind(e.target.value as Kind)}
            >
              {KINDS.map((k) => <option key={k} value={k}>{kindLabel(t, k)}</option>)}
            </select>
          )}
          <div className="flex gap-1">
            <button
              data-testid="memory-edit-save"
              className="rounded-row bg-accent px-2 text-meta text-fg-on-strong disabled:opacity-50"
              disabled={busy || value.trim() === ''}
              onClick={() => save({ value, description, ...(isCore ? {} : { kind }) })}
            >
              {t('agents.memory.save')}
            </button>
            <button
              className="rounded-row border border-border px-2 text-meta text-fg-muted"
              onClick={() => { setEditing(false); setValue(entry.value); setDescription(entry.description ?? ''); setProblem(null); }}
            >
              {t('agents.memory.cancelEdit')}
            </button>
          </div>
        </div>
      ) : (
        /* 값은 최대 8,000자다 — 펼쳐도 이 상자 안에서만 자란다. */
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-meta text-fg-muted">{entry.value}</pre>
      )}

      {problem && <div role="alert" className="text-meta text-danger">{problem}</div>}

      {!editing && (
        <div className="flex gap-1">
          <button
            data-testid="memory-edit-start"
            className="rounded-row border border-border px-1.5 text-meta text-fg-muted"
            onClick={() => setEditing(true)}
          >
            {t('agents.memory.edit')}
          </button>
          <button
            data-testid="memory-revisions-toggle"
            className="rounded-row border border-border px-1.5 text-meta text-fg-muted"
            aria-expanded={revisions !== 'closed'}
            onClick={openRevisions}
          >
            {t('agents.memory.revisions')}
          </button>
        </div>
      )}

      {revisions === null && <div className="text-meta text-fg-muted">{t('agents.memory.loading')}</div>}
      {revisions === 'error' && <div role="alert" className="text-meta text-danger">{t('agents.memory.revisionsFailed')}</div>}
      {Array.isArray(revisions) && revisions.length === 0 && (
        <div className="text-meta text-fg-muted">{t('agents.memory.noRevisions')}</div>
      )}
      {Array.isArray(revisions) && revisions.map((r, i) => (
        <div key={`${r.replacedAt}-${i}`} data-testid="memory-revision" className="rounded-row border border-border p-1">
          <div className="flex items-baseline gap-2 text-meta text-fg-subtle">
            <span className="flex-1" title={new Date(r.updatedAt).toLocaleString(locale)}>
              {t('agents.memory.revisionAt', { ago: agoLabel(new Date(r.updatedAt).getTime(), Date.now(), locale, t) })}
              {r.flagged && <span data-testid="memory-revision-flagged" className="ml-2 text-warning">{t('agents.memory.flaggedTag')}</span>}
            </span>
            <button
              data-testid="memory-revision-restore"
              className="rounded-row border border-border px-1.5 text-meta text-fg-muted disabled:opacity-50"
              disabled={busy || (isCore && r.value.length > MAX_CORE_MEMORY_LENGTH)}
              onClick={() => save({ value: r.value, description: r.description ?? '' })}
            >
              {t('agents.memory.restore')}
            </button>
          </div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-meta text-fg-muted">{r.value}</pre>
        </div>
      ))}
    </div>
  );
}
