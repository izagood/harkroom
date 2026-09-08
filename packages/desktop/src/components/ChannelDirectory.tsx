import { useEffect, useMemo, useState } from 'react';
import type { ChannelRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { useT } from '../i18n/useT';

interface Props {
  open: boolean;
  onClose: () => void;
}

type SortMode = 'name' | 'creation';

/**
 * 정렬 비교 함수(#180). **두 모드 모두 실제로 비교한다** — "생성순" 을 "서버가 준 순서를
 * 그대로 둔다" 로 구현하면 안 된다. `listChannels` 는 `order by name` 이라 그 순서가 이미
 * 이름순이고, 그러면 토글은 눌러도 아무 것도 바꾸지 않는다. 그래서 `createdAt` 을
 * `ChannelRow` 에 실어(#180) 여기서 오래된 것부터 세운다.
 */
function compareChannels(mode: SortMode, a: ChannelRow, b: ChannelRow): number {
  if (mode === 'name') return (a.name ?? '').localeCompare(b.name ?? '');
  const at = Date.parse(a.createdAt);
  const bt = Date.parse(b.createdAt);
  // 같은 시각이면 id 로 갈라 순서를 안정시킨다 — 안 그러면 렌더마다 순서가 흔들린다.
  return at === bt ? a.id.localeCompare(b.id) : at - bt;
}

export function ChannelDirectory({ open, onClose }: Props) {
  const t = useT();
  const channels = useActiveStore((s) => s.channels);
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('name');
  const [archivedOpen, setArchivedOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSortMode('name');
    setArchivedOpen(false);
  }, [open]);

  /**
   * DM 은 목록에서 뺀다 — 디렉터리는 "들어갈 수 있는 채널을 찾는 곳"이고 DM 은 사람을
   * 골라 여는 것이라 성질이 다르다. 보관된 채널(#153)은 아래 접힌 그룹으로 갈라 놓는다:
   * 본 목록에 섞으면 이미 끝난 채널이 살아 있는 채널과 같은 무게로 보인다.
   */
  const { activeChannels, archivedChannels } = useMemo(() => {
    const standard = channels.filter((ch) => ch.kind === 'standard');
    return {
      activeChannels: standard.filter((ch) => !ch.archivedAt),
      archivedChannels: standard.filter((ch) => ch.archivedAt),
    };
  }, [channels]);

  const matchesQuery = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (ch: ChannelRow) => (q ? (ch.name ?? '').toLowerCase().includes(q) : true);
  }, [query]);

  const filteredChannels = useMemo(
    () => activeChannels.filter(matchesQuery).sort((a, b) => compareChannels(sortMode, a, b)),
    [activeChannels, matchesQuery, sortMode],
  );

  // 필터는 보관 그룹에도 걸린다 — 안 걸면 이름을 좁혀 놓고 "보관됨" 을 펼쳤을 때
  // 관계없는 채널이 쏟아진다.
  const filteredArchived = useMemo(
    () => archivedChannels.filter(matchesQuery).sort((a, b) => compareChannels(sortMode, a, b)),
    [archivedChannels, matchesQuery, sortMode],
  );

  const handleChannelClick = async (channel: ChannelRow) => {
    await getController().openChannel(channel.id);
    onClose();
  };

  if (!open) return null;

  const row = (ch: ChannelRow) => (
    <li key={ch.id}>
      <button
        data-testid={`channel-row-${ch.id}`}
        className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-hover"
        onClick={() => handleChannelClick(ch)}
      >
        {ch.visibility === 'private'
          ? <span className="text-fg-subtle" aria-label={t('channelDirectory.private')} title={t('channelDirectory.private')}>🔒</span>
          : <span className="text-fg-subtle">#</span>}
        <div className="flex-1 overflow-hidden">
          <div className="font-medium text-fg">{ch.name}</div>
          {/* 주제는 이름 아래 딸린 한 줄이다 — 아랫단 11px. 이름(위 줄)은 크기를 안 적어
              본문단 13px 이고, `font-medium` 으로만 도드라진다. */}
          {ch.topic && (
            <div className="truncate text-meta text-fg-subtle">{ch.topic}</div>
          )}
        </div>
      </button>
    </li>
  );

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 p-8"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={t('channelDirectory.label')}
        className="flex max-h-full w-[36rem] flex-col overflow-hidden rounded-lg border border-border bg-surface-raised text-fg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <div className="flex items-center gap-2 border-b border-border p-3">
          <span className="font-bold">{t('channelDirectory.heading')}</span>
          <button
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-fg-muted hover:bg-surface-hover"
            aria-label={t('channelDirectory.close')}
          >
            ✕
          </button>
        </div>
        <div className="flex items-center gap-2 border-b border-border p-3">
          <input
            type="text"
            aria-label={t('channelDirectory.search')}
            placeholder={t('channelDirectory.searchPlaceholder')}
            className="flex-1 rounded border border-border bg-field px-2 py-1 text-fg placeholder-fg-subtle"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {/* 정렬 토글은 **아랫단 11px** — 옆의 검색 입력(본문단)이 이 줄의 주역이고 이
              둘은 그 결과를 어떻게 늘어놓을지 고르는 곁 조작이다. */}
          <div className="flex rounded bg-surface-sunken text-meta">
            <button
              className={`rounded px-2 py-1 ${sortMode === 'name' ? 'bg-accent text-fg-on-strong' : 'text-fg-muted hover:text-fg'}`}
              aria-pressed={sortMode === 'name'}
              onClick={() => setSortMode('name')}
            >
              {t('channelDirectory.sortName')}
            </button>
            <button
              className={`rounded px-2 py-1 ${sortMode === 'creation' ? 'bg-accent text-fg-on-strong' : 'text-fg-muted hover:text-fg'}`}
              aria-pressed={sortMode === 'creation'}
              onClick={() => setSortMode('creation')}
            >
              {t('channelDirectory.sortAge')}
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {filteredChannels.length === 0 ? (
            <p className="px-2 text-fg-subtle">
              {query ? t('channelDirectory.noMatch') : t('channelDirectory.empty')}
            </p>
          ) : (
            <ul>{filteredChannels.map(row)}</ul>
          )}
          {filteredArchived.length > 0 && (
            <div className="mt-4 border-t border-border pt-2">
              <button
                className="flex w-full items-center gap-1 px-2 pb-1 text-meta uppercase tracking-wide text-fg-subtle hover:text-fg-muted"
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((v) => !v)}
              >
                <span>{archivedOpen ? '▼' : '▶'}</span>
                {t('channelDirectory.archived', { count: filteredArchived.length })}
              </button>
              {archivedOpen && (
                <ul>{filteredArchived.map(row)}</ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
