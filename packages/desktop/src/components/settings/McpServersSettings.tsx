/**
 * MCP 레지스트리 — 스펙 2026-09-20 §6. **서버는 이름과 자격증명 종류만 안다.** 정의(명령·인자)와
 * 토큰은 각 오퍼레이터 머신의 `mcp-servers.json`(또는 `~/.claude.json`)에 있고, 여기 적힌 이름이
 * 에이전트의 `mcpServers` 가 고를 수 있는 전부다. 목록은 누구나 보고(에이전트 상세가 이 목록에서
 * 고른다), 넣고 빼는 것은 `agent.privileged` 뿐이다.
 *
 * 줄마다 **이 머신의** 정의와 OAuth 인증 상태도 보인다(2026-09-30). 인증은 머신 단위다 — 토큰은 이 머신의
 * 오퍼레이터가 들고, 여기서 한 번 인증하면 이 머신에서 도는 모든 에이전트(계정 풀의 어느 계정이든)가
 * 쓴다. 사람이 인증하러 먼저 찾는 곳이 이 페이지라 여기에 둔다 — 에이전트 상세에만 있던 동안 jaebin 이
 * "인증이 없는데?" 라고 했다. 인증은 권한과 무관하다(내 머신의 토큰이다) — `canEdit` 로 막지 않는다.
 */
import { useCallback, useEffect, useState } from 'react';
import type { McpServerRow } from '@harkroom/shared';
import type { OperatorMcpEntry } from '@harkroom/shared/daemonProtocol';
import { hasOperatorLocalSurface, listLocalMcpServers } from '../../lib/operatorLocal';
import { McpLocalAuth } from './McpLocalAuth';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { hasCapability } from '../../lib/capabilities';
import { SettingsGroup } from './primitives';
import { ConfirmDialog } from '../ConfirmDialog';
import { useT } from '../../i18n/useT';

const NAME_RE = /^[a-z0-9-]{1,32}$/;

/** 연동 페이지(`IntegrationsSettings`)의 **MCP 서버** 묶음이다(UX ⑥b-4). 전에는 페이지 하나였다. */
export function McpServersSection() {
  const t = useT();
  const me = useActiveStore((s) => s.me);
  const canEdit = hasCapability(me, 'agent.privileged');
  const [rows, setRows] = useState<McpServerRow[] | 'error' | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<McpServerRow['credentialKind']>('community');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** 이 머신의 정의. `null` = 모른다(Tauri 표면 없음·읽기 실패) — 그때는 줄에 아무것도 덧붙이지 않는다. */
  const [local, setLocal] = useState<OperatorMcpEntry[] | null>(null);
  const reloadLocal = useCallback(() => {
    if (!hasOperatorLocalSurface()) return;
    void listLocalMcpServers().then((r) => setLocal(r.servers)).catch(() => setLocal(null));
  }, []);
  const reload = useCallback(() => {
    void getController().mcpServers().then(setRows).catch(() => setRows('error'));
    reloadLocal();
  }, [reloadLocal]);
  useEffect(() => { reload(); }, [reload]);

  const add = async () => {
    setError(null);
    if (!NAME_RE.test(name)) { setError(t('mcpServers.badName')); return; }
    setBusy(true);
    try { await getController().putMcpServer(name, kind); setName(''); reload(); }
    catch (e) { setError(t('mcpServers.saveFailed', { reason: e instanceof Error ? e.message : String(e) })); }
    finally { setBusy(false); }
  };
  /**
   * **지우기 전에 한 번 묻는다**(UX ④c). 전에는 "빼기" 를 누르는 순간 지워졌다 — 이 이름을
   * 켠 에이전트는 다음 기동부터 그 MCP 없이 돈다. 실패하면 창을 닫지 않고 창 안에 적는다
   * (`ConfirmDialog` 의 약속).
   */
  const [confirming, setConfirming] = useState<McpServerRow | null>(null);
  const [removing, setRemoving] = useState(false);
  const remove = async (row: McpServerRow) => {
    setError(null);
    setRemoving(true);
    try { await getController().deleteMcpServer(row.name); setConfirming(null); reload(); }
    catch (e) { setError(t('mcpServers.deleteFailed', { reason: e instanceof Error ? e.message : String(e) })); }
    finally { setRemoving(false); }
  };

  return (
    <>
      <SettingsGroup title={t('integrations.mcp')}>
        <p className="px-4 py-3 text-meta text-fg-subtle" data-testid="mcp-servers-description">{t('mcpServers.description')}</p>
        {rows === null && <p className="px-4 py-3 text-meta text-fg-muted">{t('mcpServers.loading')}</p>}
        {rows === 'error' && <p role="alert" className="px-4 py-3 text-meta text-danger">{t('mcpServers.listFailed')}</p>}
        {Array.isArray(rows) && rows.length === 0 && <p className="px-4 py-3 text-meta text-fg-subtle">{t('mcpServers.none')}</p>}
        {Array.isArray(rows) && rows.map((row) => (
          <div key={row.name} className="flex items-center justify-between gap-4 px-4 py-3" data-testid={`mcp-server-${row.name}`}>
            <span className="min-w-0 flex-1">
              <span className="block font-mono font-medium text-fg">{row.name}</span>
              <span className="mt-0.5 block text-meta text-fg-subtle">{t(`mcpServers.kind.${row.credentialKind}`)}</span>
              {local && (() => {
                const here = local.find((d) => d.name === row.name);
                if (!here) return <span className="mt-0.5 block text-meta text-fg-subtle" data-testid={`mcp-server-local-${row.name}`}>{t('agents.mcp.missing')}</span>;
                return (
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-meta" data-testid={`mcp-server-local-${row.name}`}>
                    <McpLocalAuth entry={here} onChanged={reloadLocal} onError={setError} />
                  </span>
                );
              })()}
            </span>
            {canEdit && (
              <button
                className="shrink-0 rounded border border-border px-2 py-1 text-meta text-fg hover:bg-surface-sunken"
                aria-label={t('mcpServers.removeAction', { name: row.name })}
                onClick={() => { setError(null); setConfirming(row); }}
              >
                {t('mcpServers.remove')}
              </button>
            )}
          </div>
        ))}
      </SettingsGroup>

      {confirming && (
        <ConfirmDialog
          title={t('mcpServers.confirmTitle', { name: confirming.name })}
          detail={t('mcpServers.confirmDetail')}
          confirmLabel={t('mcpServers.remove')}
          cancelLabel={t('mcpServers.cancel')}
          detailKind="note"
          danger
          busy={removing}
          error={error}
          onConfirm={() => void remove(confirming)}
          onCancel={() => { setConfirming(null); setError(null); }}
        />
      )}
      {error && !confirming && (
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
    </>
  );
}
