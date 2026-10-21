/**
 * MCP 서버 — 설정 › 연동(UX ⑥b-4). 스펙 2026-09-20 §6 + MCP 설정 시안 v2(operator 단위, 2026-10-21).
 *
 * 한 줄이 두 단위를 함께 보인다:
 * - **머리(커뮤니티)**: 이름과 자격증명 종류. 서버 레지스트리의 것이고, 넣고 빼는 것은 `agent.privileged` 뿐이다.
 * - **operator 칸**: 그 operator 의 정의(URL·Client ID)와 OAuth 인증. 토큰은 그 operator 가 들고, 그 operator 의
 *   모든 에이전트가(계정 풀의 어느 계정이든) 같이 쓴다. 인증·정의는 **내 기계**의 일이라 권한과 무관하다.
 *
 * 지금 데스크톱이 다룰 수 있는 operator 는 이 맥 하나다 — 원격 operator 칸은 박동에 MCP 상태가 실린 뒤
 * (PR5) 같은 칸 목록에 더해진다. 칸이 하나뿐이면 칸 상자를 그리지 않고 두 줄로 접는다(시안 D9).
 *
 * 지우기는 두 갈래다(시안 D2): 「이 맥에서 지우기」(칸의 ⋯, 이 맥의 정의와 토큰)와 「커뮤니티에서 삭제」(머리의 ⋯,
 * 모든 멤버의 모든 operator 에서 이름이 빠진다). 자리가 범위를 말한다.
 */
import { useCallback, useEffect, useState } from 'react';
import type { McpServerRow } from '@harkroom/shared';
import type { OperatorMcpEntry } from '@harkroom/shared/daemonProtocol';
import { hasOperatorLocalSurface, listLocalMcpServers, removeLocalMcpServer } from '../../lib/operatorLocal';
import { useMcpSignIn } from './McpLocalAuth';
import { McpServerDialog, clientIdTail, type McpDialogMode } from './McpServerDialog';
import { presetForName } from '../../lib/mcpPresets';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { hasCapability } from '../../lib/capabilities';
import { selectAccountNames } from '../../lib/accountNames';
import { stampLabel } from '../../lib/day';
import { ConfirmDialog } from '../ConfirmDialog';
import { Menu, type MenuItem } from '../Menu';
import { useLocale, useT } from '../../i18n/useT';
import { errorText } from '../../lib/errorText';

/** operator 칸 하나. 지금은 이 맥(`local`)뿐이다 — 원격 칸은 PR5 에서 상태만 보이는 모양으로 더한다. */
export interface McpOperatorCell {
  key: string;
  label: string;
  /** 이 맥이면 칸에서 고치고 인증한다. */
  local: boolean;
  /** 그 operator 의 정의. 없으면 「정의 없음」. */
  entry: OperatorMcpEntry | undefined;
}

/** 인증이 사람 손을 기다리나 — 그때만 칸의 주 버튼이 [인증]/[다시 인증] 이고 색을 쓴다. */
function needsSignIn(entry: OperatorMcpEntry): boolean {
  const st = entry.auth;
  if (!st || entry.transport === 'stdio') return false;
  return st.state === 'expired' || st.state === 'rejected' || st.state === 'error' || (st.state === 'none' && entry.oauth);
}

/** 이 화면에서 정의를 고칠 수 있나. `~/.claude.json` 출처와 헤더가 있는 정의(값을 모른다)는 못 고친다. */
function editable(entry: OperatorMcpEntry): boolean {
  return entry.source === 'operator' && entry.transport !== 'stdio' && entry.headerKeys.length === 0;
}

const BTN = 'shrink-0 rounded-row border border-border px-2 py-0.5 text-meta font-medium text-fg hover:bg-surface-sunken disabled:opacity-50';
const BTN_PRI = 'shrink-0 rounded-row border border-accent bg-accent px-2 py-0.5 text-meta font-medium text-fg-on-strong hover:bg-accent-hover disabled:opacity-50';

function MenuButton({ items, label, testid }: { items: MenuItem[]; label: string; testid: string }) {
  if (items.length === 0) return null;
  return (
    <Menu placement="bottom" items={items} renderTrigger={(props) => (
      <button type="button" {...props} aria-label={label} data-testid={testid}
        className="shrink-0 rounded-row px-1.5 py-0.5 text-meta text-fg-muted hover:bg-surface-sunken">⋯</button>
    )} />
  );
}

/** 접힌 줄(칸 하나)의 머리 항목을 칸 ⋯ 끝에 붙인다 — ⋯ 가 위아래로 둘이면 어느 쪽이 위험한지 모양으로 못 가른다(designer #1453-1). */
function withTail(items: MenuItem[], tail: MenuItem[]): MenuItem[] {
  if (!tail.length) return items;
  return [...items, ...tail.map((x, i) => (i === 0 && items.length > 0 ? { ...x, separatorBefore: true } : x))];
}

function LocalCell({ row, entry, collapsed, tailItems, onDefine, onEdit, onRemove, onChanged, onError }: {
  row: McpServerRow;
  entry: OperatorMcpEntry | undefined;
  collapsed: boolean;
  /** 접힌 줄이면 머리 ⋯ 대신 여기 끝에 붙는 항목(커뮤니티에서 삭제). */
  tailItems: MenuItem[];
  onDefine: () => void;
  onEdit: (entry: OperatorMcpEntry) => void;
  onRemove: (entry: OperatorMcpEntry) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const names = useActiveStore(selectAccountNames);
  const { waiting, signIn, signOut } = useMcpSignIn(row.name, onChanged, onError);
  const defLabel = collapsed ? t('mcpServers.cell.defHere') : t('mcpServers.cell.def');

  if (!entry) {
    return (
      <div className="flex items-start gap-3" data-testid={`mcp-server-local-${row.name}`}>
        <div className="min-w-0 flex-1 text-meta">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-16 text-fg-muted">{defLabel}</span>
            <span className="text-fg-subtle">{t('mcpServers.cell.none')}</span>
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          <button type="button" className={BTN} data-testid={`mcp-cell-primary-${row.name}`} onClick={onDefine}>{t('mcpServers.cell.addHere')}</button>
          <MenuButton items={tailItems} label={t('mcpServers.cell.menu', { name: row.name })} testid={`mcp-cell-menu-${row.name}`} />
        </span>
      </div>
    );
  }

  const remote = entry.transport !== 'stdio';
  const st = waiting ? { state: 'pending' as const } : entry.auth;
  const presetId = presetForName(entry.name)?.definition.oauth?.clientId;
  const ownApp = entry.oauthClientId && entry.oauthClientId !== presetId;
  const authText = (() => {
    if (!remote || !st) return null;
    // 받은 때를 같이 적는다(designer #1453 n3). 옛 오퍼레이터는 `at` 을 안 실어 낱말만 보인다.
    if (st.state === 'ok') {
      return { tone: 'text-fg-muted', dot: 'bg-success', text: typeof st.at === 'number'
        ? t('mcpServers.cell.okAt', { time: stampLabel(new Date(st.at).toISOString(), locale) })
        : t('agents.mcp.auth.ok') };
    }
    if (st.state === 'pending') return { tone: 'text-fg-subtle', dot: 'bg-fg-subtle', text: t('agents.mcp.auth.pending') };
    if (st.state === 'rejected') {
      const agent = st.agentId ? names[st.agentId] : undefined;
      const time = stampLabel(new Date(st.at).toISOString(), locale);
      return {
        tone: 'text-danger', dot: 'bg-danger',
        text: agent ? t('mcpServers.cell.rejected', { time, agent: agent.displayName || agent.handle }) : t('mcpServers.cell.rejectedNoAgent', { time }),
      };
    }
    if (st.state === 'expired') return { tone: 'text-danger', dot: 'bg-danger', text: t('mcpServers.cell.expired') };
    if (st.state === 'error') return { tone: 'text-danger', dot: 'bg-danger', text: t('agents.mcp.auth.error', { reason: st.reason }) };
    return entry.oauth ? { tone: 'text-warning', dot: 'bg-warning', text: t('mcpServers.cell.needed') } : null;
  })();

  const signInNeeded = needsSignIn(entry) && !waiting;
  const canEditHere = editable(entry);
  const items: MenuItem[] = [];
  if (remote && st && st.state !== 'pending' && !signInNeeded) items.push({ label: st.state === 'none' ? t('agents.mcp.auth.start') : t('agents.mcp.auth.again'), onSelect: signIn });
  if (remote && st?.state === 'ok') items.push({ label: t('mcpServers.cell.signOut'), onSelect: signOut });
  if (canEditHere && signInNeeded) items.push({ label: t('mcpServers.cell.edit'), onSelect: () => onEdit(entry) });
  if (entry.source === 'operator') items.push({ label: t('mcpServers.cell.removeHere'), onSelect: () => onRemove(entry), separatorBefore: items.length > 0 });

  return (
    <div className="flex items-start gap-3" data-testid={`mcp-server-local-${row.name}`}>
      <div className="min-w-0 flex-1 text-meta">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-16 text-fg-muted">{defLabel}</span>
          <span className="min-w-0 break-all text-fg">{entry.target.replace(/^https?:\/\//, '')}</span>
          {ownApp && <span className="rounded-row bg-accent-surface px-1.5 text-accent-text" data-testid={`mcp-cell-own-app-${row.name}`}>
            {t('mcpServers.cell.ownApp', { tail: clientIdTail(entry.oauthClientId!) })}</span>}
          {entry.source === 'claude' && <span className="rounded-row border border-border px-1.5 text-fg-muted">{t('mcpServers.cell.claudeJson')}</span>}
          {entry.source === 'operator' && entry.headerKeys.length > 0 && <span className="rounded-row border border-border px-1.5 text-fg-muted">{t('mcpServers.cell.headers')}</span>}
        </div>
        {authText && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5" data-testid={`agent-mcp-auth-${row.name}`}
            title={st?.state === 'rejected' ? t('agents.mcp.auth.rejectedNote') : t('agents.mcp.auth.note')}>
            <span className="min-w-16 text-fg-muted">{t('mcpServers.cell.auth')}</span>
            <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${authText.dot}`} />
            <span className={authText.tone}>{authText.text}</span>
          </div>
        )}
      </div>
      <span className="flex shrink-0 items-center gap-1">
        {signInNeeded
          ? <button type="button" className={BTN_PRI} data-testid={`agent-mcp-auth-start-${row.name}`} onClick={signIn}>
              {st?.state === 'none' ? t('agents.mcp.auth.start') : t('agents.mcp.auth.again')}</button>
          : canEditHere && <button type="button" className={BTN} data-testid={`mcp-cell-primary-${row.name}`} onClick={() => onEdit(entry)}>{t('mcpServers.cell.edit')}</button>}
        <MenuButton items={withTail(items, tailItems)} label={t('mcpServers.cell.menu', { name: row.name })} testid={`mcp-cell-menu-${row.name}`} />
      </span>
    </div>
  );
}

export function McpServersSection() {
  const t = useT();
  const me = useActiveStore((s) => s.me);
  const canEdit = hasCapability(me, 'agent.privileged');
  const [rows, setRows] = useState<McpServerRow[] | 'error' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<McpDialogMode | null>(null);

  /** 이 머신의 정의. `null` = 모른다(Tauri 표면 없음·읽기 실패) — 그때는 칸을 그리지 않는다. */
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

  /** 「커뮤니티에서 삭제」 — 한 번 묻고(UX ④c), 이 맥의 정의·토큰도 함께 지울지 고른다(기본 켬). */
  const [confirming, setConfirming] = useState<McpServerRow | null>(null);
  // 기본은 끈다 — 이 맥의 정의는 이 맥의 **모든 커뮤니티**가 같이 쓴다. 한 커뮤니티에서 이름을 지운다고
  // 다른 커뮤니티 에이전트가 쓰던 정의·토큰까지 지우면 그쪽이 mcp_server_missing 으로 멈춘다(security #1453 n3).
  const [alsoLocal, setAlsoLocal] = useState(false);
  const [removing, setRemoving] = useState(false);
  const localEntry = (name: string) => local?.find((d) => d.name === name);
  const remove = async (row: McpServerRow) => {
    setError(null);
    setRemoving(true);
    try {
      await getController().deleteMcpServer(row.name);
      if (alsoLocal && localEntry(row.name)?.source === 'operator') await removeLocalMcpServer(row.name);
      setConfirming(null);
      reload();
    } catch (e) { setError(t('mcpServers.deleteFailed', { reason: errorText(e, t) })); }
    finally { setRemoving(false); }
  };

  /** 「이 맥에서 지우기」 — 정의와 토큰(오퍼레이터의 `remove` 가 토큰도 버린다). 커뮤니티 이름은 그대로. */
  const [removingLocal, setRemovingLocal] = useState<OperatorMcpEntry | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const removeLocal = async (entry: OperatorMcpEntry) => {
    setError(null);
    setLocalBusy(true);
    try { await removeLocalMcpServer(entry.name); setRemovingLocal(null); reloadLocal(); }
    catch (e) { setError(t('mcpServers.removeHereFailed', { reason: errorText(e, t) })); }
    finally { setLocalBusy(false); }
  };

  const registry = Array.isArray(rows) ? rows : [];
  const cellsOf = (row: McpServerRow): McpOperatorCell[] =>
    local ? [{ key: 'local', label: t('mcpServers.cell.thisMac'), local: true, entry: localEntry(row.name) }] : [];
  const canAdd = canEdit || (hasOperatorLocalSurface() && registry.length > 0);

  return (
    <>
      <section className="mb-8">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-body font-semibold text-fg-subtle">{t('integrations.mcp')}</h3>
          {canAdd && (
            <button type="button" className={BTN} data-testid="mcp-server-add-open" onClick={() => { setError(null); setDialog({ kind: 'add' }); }}>
              {t('mcpServers.addOpen')}
            </button>
          )}
        </div>
        <div className="divide-y divide-border rounded-compose border border-border bg-surface-raised">
          <p className="px-4 py-3 text-meta text-fg-subtle" data-testid="mcp-servers-description">{t('mcpServers.descriptionHere')}</p>
          {rows === null && <p className="px-4 py-3 text-meta text-fg-muted">{t('mcpServers.loading')}</p>}
          {rows === 'error' && <p role="alert" className="px-4 py-3 text-meta text-danger">{t('mcpServers.listFailed')}</p>}
          {Array.isArray(rows) && rows.length === 0 && <p className="px-4 py-3 text-meta text-fg-subtle">{t('mcpServers.none')}</p>}
          {registry.map((row) => {
            const cells = cellsOf(row);
            const collapsed = cells.length === 1;
            const headItems: MenuItem[] = canEdit
              ? [{ label: t('mcpServers.removeCommunity'), tone: 'danger', onSelect: () => { setError(null); setAlsoLocal(false); setConfirming(row); } }]
              : [];
            return (
              <div key={row.name} className="flex flex-col gap-2 px-4 py-3" data-testid={`mcp-server-${row.name}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="font-mono font-medium text-fg">{row.name}</span>
                    <span className="text-meta text-fg-subtle"> · {t(`mcpServers.kind.${row.credentialKind}`)}</span>
                  </span>
                  {!collapsed && <MenuButton items={headItems} label={t('mcpServers.removeAction', { name: row.name })} testid={`mcp-server-menu-${row.name}`} />}
                </div>
                {cells.map((cell) => {
                  const body = (
                    <LocalCell row={row} entry={cell.entry} collapsed={collapsed} tailItems={collapsed ? headItems : []}
                      onDefine={() => { setError(null); setDialog({ kind: 'define', row }); }}
                      onEdit={(entry) => { setError(null); setDialog({ kind: 'edit', row, entry }); }}
                      onRemove={(entry) => { setError(null); setRemovingLocal(entry); }}
                      onChanged={reloadLocal} onError={setError} />
                  );
                  return collapsed ? <div key={cell.key}>{body}</div> : (
                    <div key={cell.key} className="grid grid-cols-[8.5rem_1fr] gap-2 rounded-row border border-border bg-surface px-2.5 py-2">
                      <span className="text-meta font-semibold text-fg">{cell.label}</span>
                      {body}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </section>

      {confirming && (
        <ConfirmDialog
          title={t('mcpServers.confirmTitle', { name: confirming.name })}
          detail={(
            <span className="flex flex-col gap-2">
              <span>{t('mcpServers.confirmDetailCommunity')}</span>
              {localEntry(confirming.name)?.source === 'operator' && (
                <span className="flex flex-col gap-0.5">
                  <label className="flex items-center gap-1.5 text-fg">
                    <input type="checkbox" checked={alsoLocal} disabled={removing} data-testid="mcp-confirm-also-local"
                      onChange={(e) => setAlsoLocal(e.target.checked)} />
                    {t('mcpServers.confirmAlsoLocal')}
                  </label>
                  <span className="text-fg-subtle" data-testid="mcp-confirm-also-local-note">{t('mcpServers.confirmAlsoLocalNote')}</span>
                </span>
              )}
            </span>
          )}
          confirmLabel={t('mcpServers.removeCommunity')}
          cancelLabel={t('mcpServers.cancel')}
          detailKind="note"
          danger
          busy={removing}
          error={error}
          onConfirm={() => void remove(confirming)}
          onCancel={() => { setConfirming(null); setError(null); }}
        />
      )}
      {removingLocal && (
        <ConfirmDialog
          title={t('mcpServers.removeHereTitle', { name: removingLocal.name })}
          detail={t('mcpServers.removeHereDetail')}
          confirmLabel={t('mcpServers.cell.removeHere')}
          cancelLabel={t('mcpServers.cancel')}
          detailKind="note"
          busy={localBusy}
          error={error}
          onConfirm={() => void removeLocal(removingLocal)}
          onCancel={() => { setRemovingLocal(null); setError(null); }}
        />
      )}
      {dialog && (
        <McpServerDialog mode={dialog} registry={registry} canEdit={canEdit}
          onDone={() => { setDialog(null); reload(); }} onCancel={() => setDialog(null)} />
      )}
      {error && !confirming && !removingLocal && (
        <div className="mb-4 rounded-row border border-danger-border bg-danger-surface p-3">
          <p role="alert" className="text-meta text-danger">{error}</p>
        </div>
      )}
    </>
  );
}
