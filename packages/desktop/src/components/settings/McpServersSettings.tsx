/**
 * MCP 레지스트리 — 스펙 2026-09-20 §6. **서버는 이름과 자격증명 종류만 안다.** 정의(명령·인자)와
 * 토큰은 각 오퍼레이터 머신의 `mcp-servers.json`(또는 `~/.claude.json`)에 있고, 여기 적힌 이름이
 * 에이전트의 `mcpServers` 가 고를 수 있는 전부다. 목록은 누구나 보고(에이전트 상세가 이 목록에서
 * 고른다), 넣고 빼는 것은 `agent.privileged` 뿐이다.
 */
import { useCallback, useEffect, useState } from 'react';
import type { McpServerRow } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { hasCapability } from '../../lib/capabilities';
import { SettingsGroup, SettingsPage } from './primitives';
import { useT } from '../../i18n/useT';

const NAME_RE = /^[a-z0-9-]{1,32}$/;

export function McpServersSettings() {
  const t = useT();
  const me = useActiveStore((s) => s.me);
  const canEdit = hasCapability(me, 'agent.privileged');
  const [rows, setRows] = useState<McpServerRow[] | 'error' | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<McpServerRow['credentialKind']>('community');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    void getController().mcpServers().then(setRows).catch(() => setRows('error'));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const add = async () => {
    setError(null);
    if (!NAME_RE.test(name)) { setError(t('mcpServers.badName')); return; }
    setBusy(true);
    try { await getController().putMcpServer(name, kind); setName(''); reload(); }
    catch (e) { setError(t('mcpServers.saveFailed', { reason: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(false); }
  };
  const remove = async (row: McpServerRow) => {
    setError(null);
    try { await getController().deleteMcpServer(row.name); reload(); }
    catch (e) { setError(t('mcpServers.deleteFailed', { reason: e instanceof Error ? e.message : String(e) })); }
  };

  return (
    <SettingsPage title="MCP servers" description={t('mcpServers.description')}>
      <SettingsGroup>
        {rows === null && <p className="px-4 py-3 text-meta text-fg-muted">{t('mcpServers.loading')}</p>}
        {rows === 'error' && <p role="alert" className="px-4 py-3 text-meta text-danger">{t('mcpServers.listFailed')}</p>}
        {Array.isArray(rows) && rows.length === 0 && <p className="px-4 py-3 text-meta text-fg-subtle">{t('mcpServers.none')}</p>}
        {Array.isArray(rows) && rows.map((row) => (
          <div key={row.name} className="flex items-center justify-between gap-4 px-4 py-3" data-testid={`mcp-server-${row.name}`}>
            <span className="min-w-0 flex-1">
              <span className="block font-mono font-medium text-fg">{row.name}</span>
              <span className="mt-0.5 block text-meta text-fg-subtle">{t(`mcpServers.kind.${row.credentialKind}`)}</span>
            </span>
            {canEdit && (
              <button
                className="shrink-0 rounded border border-border px-2 py-1 text-meta text-fg hover:bg-surface-sunken"
                aria-label={t('mcpServers.removeAction', { name: row.name })}
                onClick={() => void remove(row)}
              >
                {t('mcpServers.remove')}
              </button>
            )}
          </div>
        ))}
      </SettingsGroup>

      {error && (
        <div className="mb-4 rounded border border-danger-border bg-danger-surface p-3">
          <p role="alert" className="text-meta text-danger">{error}</p>
        </div>
      )}

      {canEdit && (
        <SettingsGroup title={t('mcpServers.addTitle')}>
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <input
              aria-label={t('mcpServers.name')}
              className="rounded border border-border bg-surface px-2 py-1 font-mono text-meta text-fg"
              placeholder="github"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
            <select
              aria-label={t('mcpServers.kindLabel')}
              className="rounded border border-border bg-surface px-2 py-1 text-meta text-fg"
              value={kind}
              disabled={busy}
              onChange={(e) => setKind(e.target.value as McpServerRow['credentialKind'])}
            >
              <option value="community">{t('mcpServers.kind.community')}</option>
              <option value="personal">{t('mcpServers.kind.personal')}</option>
            </select>
            <button
              className="rounded bg-accent px-3 py-1 text-meta font-medium text-fg-on-strong disabled:opacity-50"
              disabled={busy || !name}
              onClick={() => void add()}
            >
              {t('mcpServers.add')}
            </button>
          </div>
          <p className="px-4 pb-3 text-meta text-fg-subtle">{t('mcpServers.addNote')}</p>
        </SettingsGroup>
      )}
    </SettingsPage>
  );
}
