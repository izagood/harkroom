/**
 * MCP 서버 — 설정 › 연동(UX ⑥b-4). 스펙 2026-09-20 §6 + MCP 설정 시안 v2(operator 단위, 2026-10-21).
 *
 * 한 줄이 두 단위를 함께 보인다:
 * - **머리(커뮤니티)**: 이름과 자격증명 종류. 서버 레지스트리의 것이고, 넣고 빼는 것은 `agent.privileged` 뿐이다.
 * - **operator 칸**: 그 operator 의 정의(URL·Client ID)와 OAuth 인증. 토큰은 그 operator 가 들고, 그 operator 의
 *   모든 에이전트가(계정 풀의 어느 계정이든) 같이 쓴다. 인증·정의는 **내 기계**의 일이라 권한과 무관하다.
 *
 * 지금 데스크톱이 고칠 수 있는 operator 는 이 맥 하나다. 내가 주인인 원격 operator(시안 D8)는 박동 `status.mcp`
 * 로 **상태만** 보이는 칸이 된다(PR5) — 편집·인증은 P3b·P6 뒤. 칸이 하나뿐이면 칸 상자를 그리지 않고 두 줄로
 * 접는다(시안 D9).
 *
 * 지우기는 두 갈래다(시안 D2): 「이 맥에서 지우기」(칸의 ⋯, 이 맥의 정의와 토큰)와 「커뮤니티에서 삭제」(머리의 ⋯,
 * 모든 멤버의 모든 operator 에서 이름이 빠진다). 자리가 범위를 말한다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentView, McpServerRow, OperatorView } from '@harkroom/shared';
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
import { useLocalOperatorId } from '../../lib/useLocalOperatorId';
import { takeMcpFocus } from '../../lib/mcpFocus';
import { clientIdFingerprint, remoteMcpState, useActiveBaseUrl, useOwnedOperators, type RemoteMcpState } from '../../lib/mcpRemote';
import { operatorDisplayName } from '../../lib/operatorName';

/** operator 칸 하나. 이 맥(`local`)은 고치고 인증한다. 원격은 박동 상태만 보인다. */
export interface McpOperatorCell {
  key: string;
  label: string;
  /** 이 맥이면 칸에서 고치고 인증한다. */
  local: boolean;
  /** 원격 칸의 operator(박동 상태의 출처). */
  op?: OperatorView;
  /** 그 operator 의 정의. 없으면 「정의 없음」. */
  entry: OperatorMcpEntry | undefined;
  /** 그 operator 에 배정됐고 이 서버를 켠 에이전트 이름. `null` = 모른다(목록을 못 읽음). */
  agents: string[] | null;
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

/** D11 재료 — 내 다른 operator 하나와 그 operator 의 이 이름 상태. */
interface SlotPeer { label: string; state: RemoteMcpState; agents: string[] | null }

function LocalCell({ row, entry, collapsed, agentsOn, slotPeers, baseUrl, tailItems, onDefine, onEdit, onRemove, onChanged, onError }: {
  row: McpServerRow;
  /**
   * 토큰 칸 상한이 있는 프리셋(`tokenSlots`)일 때만 — 내 다른 operator 들의 이 이름 상태. 같은 지문으로 인증돼 있으면
   * [인증] 전에 묻는다(시안 v2 D11). 상한이 없는 서버는 빈 목록.
   */
  slotPeers: SlotPeer[];
  baseUrl: string | null;
  entry: OperatorMcpEntry | undefined;
  collapsed: boolean;
  /** 이 operator 에서 이 서버를 켠 에이전트 — 정의가 없는데 켠 에이전트가 있으면 [이 맥에 추가] 를 채운 색으로(시안 v2 §2). */
  agentsOn: string[] | null;
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
  const { waiting, signIn: rawSignIn, signOut } = useMcpSignIn(row.name, onChanged, onError);
  const defLabel = collapsed ? t('mcpServers.cell.defHere') : t('mcpServers.cell.def');

  // D11: 이 맥 정의의 Client ID 지문(오퍼레이터와 같은 식). 지문이 같은 다른 operator 가 인증돼 있으면 묻고 연다.
  const clientId = entry?.oauthClientId ?? (entry ? presetForName(entry.name)?.definition.oauth?.clientId : undefined);
  const [fp, setFp] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setFp(null);
    if (!clientId || !baseUrl || slotPeers.length === 0) return;
    void clientIdFingerprint(baseUrl, clientId).then((v) => { if (live) setFp(v); }).catch(() => { if (live) setFp(null); });
    return () => { live = false; };
  }, [clientId, baseUrl, slotPeers.length]);
  const clashing = fp ? slotPeers.filter((p) => p.state.kind === 'defined' && p.state.entry.clientIdFp === fp
    && (p.state.entry.auth === 'ok' || p.state.entry.auth === 'expired')) : [];
  // 지문을 모르는 다른 operator(박동 전·오프라인·옛 판) — 창 대신 회색 한 줄(시안 §6 표).
  const unknownPeers = slotPeers.filter((p) => p.state.kind === 'unknown' || p.state.kind === 'offline'
    || (p.state.kind === 'defined' && !p.state.entry.clientIdFp));
  const [askClash, setAskClash] = useState(false);
  const signIn = () => { if (clashing.length > 0) setAskClash(true); else rawSignIn(); };

  if (!entry) {
    return (
      <div className="flex items-start gap-3" data-testid={`mcp-server-local-${row.name}`}>
        <div className="min-w-0 flex-1 text-meta">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-16 text-fg-muted">{defLabel}</span>
            {agentsOn && agentsOn.length > 0
              ? <span className="text-danger" data-testid={`mcp-cell-missing-on-${row.name}`}>{t('mcpServers.cell.noneOn', { agents: agentsOn.join(' · ') })}</span>
              : <span className="text-fg-subtle">{t('mcpServers.cell.none')}</span>}
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          <button type="button" className={agentsOn && agentsOn.length > 0 ? BTN_PRI : BTN} data-testid={`mcp-cell-primary-${row.name}`} onClick={onDefine}>{t('mcpServers.cell.addHere')}</button>
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
        {entry.oauth && unknownPeers.length > 0 && (
          <div className="mt-1 text-fg-subtle" data-testid={`mcp-cell-slot-note-${row.name}`}>
            {t('mcpServers.slots.unknownNote', { hosts: unknownPeers.map((p) => p.label).join(' · '), name: row.name })}
          </div>
        )}
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
      {askClash && clashing.length > 0 && (
        <ConfirmDialog
          title={t('mcpServers.slots.title', { name: row.name, host: clashing[0]!.label })}
          detail={(
            <span className="flex flex-col gap-2" data-testid={`mcp-slot-clash-${row.name}`}>
              <span>{t('mcpServers.slots.why', { tail: clientId ? clientIdTail(clientId) : '' })}</span>
              {clashing.map((p) => (
                <span key={p.label} className="rounded-row border border-warning-border bg-warning-surface px-2 py-1 text-warning">
                  {t('mcpServers.slots.peer', {
                    host: p.label,
                    state: p.state.kind === 'defined' && p.state.entry.auth === 'expired' ? t('mcpServers.cell.expired') : t('agents.mcp.auth.ok'),
                    agents: p.agents && p.agents.length > 0 ? p.agents.join(' · ') : '—',
                  })}
                </span>
              ))}
              <span className="text-fg-subtle">{t('mcpServers.slots.hintOtherApp')}</span>
              <span className="text-fg-subtle">{t('mcpServers.slots.hintSignOut', { host: clashing[0]!.label })}</span>
              {editable(entry) && (
                <button type="button" className="self-start text-accent-text hover:underline" data-testid={`mcp-slot-edit-${row.name}`}
                  onClick={() => { setAskClash(false); onEdit(entry); }}>{t('mcpServers.slots.otherClientId')}</button>
              )}
            </span>
          )}
          confirmLabel={t('mcpServers.slots.anyway')}
          cancelLabel={t('mcpServers.cancel')}
          detailKind="note"
          onConfirm={() => { setAskClash(false); rawSignIn(); }}
          onCancel={() => setAskClash(false)}
        />
      )}
    </div>
  );
}

/**
 * 원격 operator 칸 — 박동 상태만 보인다(시안 v2 §2, D10). 버튼은 없고 「보기만」 칩. 정의가 없는데 그 operator 에서
 * 켠 에이전트가 있으면 빨강(그 에이전트는 배정이 거절돼 멈춰 있다).
 */
function RemoteCell({ row, state, agentsOn }: { row: McpServerRow; state: RemoteMcpState; agentsOn: string[] | null }) {
  const t = useT();
  const locale = useLocale();
  const testid = `mcp-remote-state-${row.name}`;
  const line = (() => {
    if (state.kind === 'offline') {
      return <span className="text-fg-subtle" data-testid={testid}>{state.lastSeenAt
        ? t('mcpServers.remote.offlineAt', { time: stampLabel(state.lastSeenAt, locale) }) : t('mcpServers.remote.offline')}</span>;
    }
    if (state.kind === 'unknown') return <span className="text-fg-subtle" data-testid={testid}>{t('mcpServers.remote.unknown')}</span>;
    if (state.kind === 'missing') {
      return agentsOn && agentsOn.length > 0
        ? <span className="text-danger" data-testid={testid}>{t('mcpServers.remote.missingOn', { agents: agentsOn.join(' · ') })}</span>
        : <span className="text-fg-subtle" data-testid={testid}>{t('mcpServers.cell.none')}</span>;
    }
    return null;
  })();
  const entry = state.kind === 'defined' ? state.entry : null;
  const auth = (() => {
    if (!entry || entry.transport === 'stdio' || !entry.auth) return null;
    const time = entry.authAt ? stampLabel(entry.authAt, locale) : null;
    switch (entry.auth) {
      case 'ok': return { tone: 'text-fg-muted', dot: 'bg-success', text: time ? t('mcpServers.cell.okAt', { time }) : t('agents.mcp.auth.ok') };
      case 'rejected': return { tone: 'text-danger', dot: 'bg-danger', text: time ? t('mcpServers.cell.rejectedNoAgent', { time }) : t('agents.mcp.authWord.rejected') };
      case 'expired': return { tone: 'text-danger', dot: 'bg-danger', text: t('mcpServers.cell.expired') };
      case 'error': return { tone: 'text-danger', dot: 'bg-danger', text: t('agents.mcp.authWord.error') };
      case 'pending': return { tone: 'text-fg-subtle', dot: 'bg-fg-subtle', text: t('agents.mcp.auth.pending') };
      default: return entry.oauth ? { tone: 'text-warning', dot: 'bg-warning', text: t('mcpServers.cell.needed') } : null;
    }
  })();
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1 text-meta">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-16 text-fg-muted">{t('mcpServers.cell.def')}</span>
          {line ?? (
            <span className="text-fg-muted" data-testid={testid}>
              {entry!.source === 'claude' ? t('mcpServers.remote.definedClaude') : t('mcpServers.remote.defined')}
            </span>
          )}
        </div>
        {auth && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5" data-testid={`mcp-remote-auth-${row.name}`}>
            <span className="min-w-16 text-fg-muted">{t('mcpServers.cell.auth')}</span>
            <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${auth.dot}`} />
            <span className={auth.tone}>{auth.text}</span>
          </div>
        )}
      </div>
      <span className="shrink-0 px-1.5 text-meta text-fg-subtle" title={t('mcpServers.remote.viewOnlyNote')}>
        {t('mcpServers.remote.viewOnly')}
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

  /**
   * 이 맥 operator 에 배정된 에이전트 — 칸의 「에이전트 n」, [이 맥에 추가] 의 색, 지우기 확인창의 「영향받는 에이전트」
   * 재료다. 이 맥 operator 를 모르거나 목록을 못 읽으면 `null`(그 표시만 빠진다).
   */
  const localOperatorId = useLocalOperatorId();
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => getController().listAgents())
      .then((rows) => { if (live) setAgents(rows); }).catch(() => { if (live) setAgents(null); });
    return () => { live = false; };
  }, []);
  const onAt = (operatorId: string, name: string): string[] | null => {
    if (!agents) return null;
    return agents
      .filter((a) => a.assignment?.operatorId === operatorId && (a.mcpServers ?? []).includes(name))
      .map((a) => a.displayName || a.handle);
  };
  const onHere = (name: string): string[] | null => (typeof localOperatorId === 'string' ? onAt(localOperatorId, name) : null);

  /** 내가 주인인 원격 operator(시안 D8). 이 기기 operator 를 아직 모르면 가를 수 없어 그리지 않는다. */
  const owned = useOwnedOperators();
  const baseUrl = useActiveBaseUrl();
  const remotes: OperatorView[] = owned && localOperatorId !== 'unknown' ? owned.filter((o) => o.id !== localOperatorId) : [];
  /** 이름을 켠 에이전트 전부(어느 operator 든) — 커뮤니티 삭제는 모든 operator 에서 이름이 빠진다. */
  const onAnywhere = (name: string): string[] | null =>
    agents ? agents.filter((a) => (a.mcpServers ?? []).includes(name)).map((a) => a.displayName || a.handle) : null;

  /**
   * 에이전트 화면의 「연동에서 … →」 로 왔으면 그 줄로 스크롤하고 잠깐(2초) 강조한다(`mcpFocus`). 목록이 그려진 뒤 한 번.
   */
  const [flash, setFlash] = useState<string | null>(null);
  const [flashOp, setFlashOp] = useState<string | null>(null);
  const focusTaken = useRef(false);
  useEffect(() => {
    if (focusTaken.current || !Array.isArray(rows)) return;
    focusTaken.current = true;
    const focus = takeMcpFocus();
    if (!focus) return;
    const { name, operatorId } = focus;
    setFlash(name);
    setFlashOp(operatorId ?? null);
    // 이름은 레지스트리 문법([a-z0-9-])이라 선택자에 그대로 넣어도 된다 — 그래도 문법을 벗어나면 찾지 않는다.
    // 원격 칸으로 가는 링크면(designer #1455 n3) 그 칸을, 칸이 아직 없으면 줄을 보인다.
    if (/^[a-z0-9-]{1,32}$/.test(name)) {
      const cell = operatorId && /^[A-Za-z0-9-]{1,64}$/.test(operatorId)
        ? document.querySelector(`[data-testid="mcp-cell-${name}-${operatorId}"]`) : null;
      (cell ?? document.querySelector(`[data-testid="mcp-server-${name}"]`))?.scrollIntoView?.({ block: 'center' });
    }
    const timer = setTimeout(() => { setFlash(null); setFlashOp(null); }, 2000);
    return () => clearTimeout(timer);
  }, [rows]);

  /** 「커뮤니티에서 삭제」 — 한 번 묻고(UX ④c), 이 맥의 정의·토큰도 함께 지울지 고른다(기본 끔). */
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
  const cellsOf = (row: McpServerRow): McpOperatorCell[] => [
    ...(local ? [{ key: 'local', label: t('mcpServers.cell.thisMac'), local: true, entry: localEntry(row.name), agents: onHere(row.name) }] : []),
    ...remotes.map((op) => ({ key: op.id, label: operatorDisplayName(op), local: false, op, entry: undefined, agents: onAt(op.id, row.name) })),
  ];
  /** D11 재료 — 토큰 칸 상한이 있는 프리셋일 때만 내 다른 operator 들의 상태. */
  const slotPeersOf = (row: McpServerRow): SlotPeer[] => (presetForName(row.name)?.tokenSlots
    ? remotes.map((op) => ({ label: operatorDisplayName(op), state: remoteMcpState(op, row.name), agents: onAt(op.id, row.name) }))
    : []);
  /** 원격 칸 안내는 원격 칸이 처음 나오는 줄에 한 번만(시안 D10). */
  const firstRemoteRow = remotes.length > 0 ? registry[0]?.name : undefined;
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
          <p className="px-4 py-3 text-meta text-fg-subtle" data-testid="mcp-servers-description">{remotes.length > 0 ? t('mcpServers.descriptionOperators') : t('mcpServers.descriptionHere')}</p>
          {rows === null && <p className="px-4 py-3 text-meta text-fg-muted">{t('mcpServers.loading')}</p>}
          {rows === 'error' && <p role="alert" className="px-4 py-3 text-meta text-danger">{t('mcpServers.listFailed')}</p>}
          {Array.isArray(rows) && rows.length === 0 && <p className="px-4 py-3 text-meta text-fg-subtle">{t('mcpServers.none')}</p>}
          {registry.map((row) => {
            const cells = cellsOf(row);
            // operator 칸으로 왔으면 칸만 칠한다 — 줄까지 칠하면 칸 강조가 줄 바탕에 묻힌다.
            const rowLit = flash === row.name && !flashOp;
            const collapsed = cells.length === 1 && cells[0]!.local;
            const headItems: MenuItem[] = canEdit
              ? [{ label: t('mcpServers.removeCommunity'), tone: 'danger', onSelect: () => { setError(null); setAlsoLocal(false); setConfirming(row); } }]
              : [];
            return (
              <div key={row.name} className={`flex flex-col gap-2 px-4 py-3 transition-colors ${rowLit ? 'bg-accent-surface' : ''}`}
                data-testid={`mcp-server-${row.name}`} data-flash={rowLit ? 'true' : undefined}>
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="font-mono font-medium text-fg">{row.name}</span>
                    <span className="text-meta text-fg-subtle"> · {t(`mcpServers.kind.${row.credentialKind}`)}</span>
                  </span>
                  {!collapsed && <MenuButton items={headItems} label={t('mcpServers.removeAction', { name: row.name })} testid={`mcp-server-menu-${row.name}`} />}
                </div>
                {cells.map((cell) => {
                  const body = !cell.local ? (
                    <RemoteCell row={row} state={remoteMcpState(cell.op!, row.name)} agentsOn={cell.agents} />
                  ) : (
                    <LocalCell row={row} entry={cell.entry} collapsed={collapsed} agentsOn={cell.agents} slotPeers={slotPeersOf(row)} baseUrl={baseUrl}
                      tailItems={collapsed ? headItems : []}
                      onDefine={() => { setError(null); setDialog({ kind: 'define', row }); }}
                      onEdit={(entry) => { setError(null); setDialog({ kind: 'edit', row, entry }); }}
                      onRemove={(entry) => { setError(null); setRemovingLocal(entry); }}
                      onChanged={reloadLocal} onError={setError} />
                  );
                  const lit = flash === row.name && flashOp === cell.key;
                  return collapsed ? <div key={cell.key}>{body}</div> : (
                    <div key={cell.key} data-testid={`mcp-cell-${row.name}-${cell.key}`} data-flash={lit ? 'true' : undefined}
                      className={`grid grid-cols-1 gap-2 rounded-row border px-2.5 py-2 sm:grid-cols-[8.5rem_1fr] ${cell.local ? 'border-border' : 'border-dashed border-border'} ${lit ? 'bg-accent-surface' : cell.local ? 'bg-surface' : 'bg-transparent'}`}>
                      <span className="flex min-w-0 flex-col text-meta font-semibold text-fg">
                        <span className="truncate" title={cell.label}>
                          {cell.label}
                          {!cell.local && <span className="ml-1 rounded-row border border-border px-1 font-normal text-fg-subtle">{t('agents.mcp.where.remoteTag')}</span>}
                        </span>
                        {cell.agents && (
                          <span className="font-normal text-fg-subtle" title={cell.agents.join(', ')} data-testid={`mcp-cell-agents-${row.name}`}>
                            {t('mcpServers.cell.agentCount', { n: cell.agents.length })}
                          </span>
                        )}
                      </span>
                      {body}
                    </div>
                  );
                })}
                {row.name === firstRemoteRow && (
                  <p className="text-meta text-fg-subtle" data-testid="mcp-remote-hint">{t('mcpServers.remote.viewOnlyNote')}</p>
                )}
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
              {(() => {
                const hit = onAnywhere(confirming.name);
                return hit && hit.length > 0 && (
                  <span className="text-danger" data-testid="mcp-confirm-affected">{t('mcpServers.confirmAffected', { n: hit.length, agents: hit.join(' · ') })}</span>
                );
              })()}
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
          detail={(
            <span className="flex flex-col gap-2">
              <span>{t('mcpServers.removeHereDetail')}</span>
              {(() => {
                const hit = onHere(removingLocal.name);
                return hit && hit.length > 0 && (
                  <span className="text-warning" data-testid="mcp-remove-here-affected">{t('mcpServers.removeHereAffected', { n: hit.length, agents: hit.join(' · ') })}</span>
                );
              })()}
            </span>
          )}
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
