/**
 * 에이전트 상세의 **MCP** 절 — 이 에이전트에 **무엇을 켜나**만 다룬다(MCP 설정 시안 v2 §7·§8, 2026-10-21).
 *
 * 정의(URL·Client ID)와 인증은 **오퍼레이터** 단위라 설정 › 연동 › MCP 서버에서 고친다 — 전에는 이 절이 이 맥의
 * 정의를 쓰고 인증 버튼도 가졌는데, 그러면 에이전트 A 의 화면에서 고친 것이 같은 맥의 B·C 에도 닿았고 원격
 * 오퍼레이터에 배정된 에이전트에는 틀린 상태(이 맥 기준)를 보였다.
 *
 * 여기서는:
 * - 절 머리에 **어디서 도는가**(이 맥 / 원격 오퍼레이터 / 배정 전)를 적고, 줄 상태는 **배정된 오퍼레이터 기준**이다.
 *   이 맥이면 오퍼레이터 소켓의 목록(`listLocalMcpServers`), 원격·모름이면 「상태 모름」(원격 칸은 박동 상태로 채운다).
 * - 정상은 말하지 않는다. 손이 필요할 때만 한 줄과 「연동에서 … →」 링크 — 링크는 연동의 그 줄로 간다(`mcpFocus`).
 * - 정의가 없어도 켜는 것은 막지 않는다 — 원격 호스트에서 정의를 나중에 넣는 순서도 되게. 대신 켜면 경고한다.
 * - personal 서버를 켜면 "호출자가 소유자로 좁혀진다"를 확인받고 scope 를 **같은 PATCH** 로 바꾼다.
 * - [+ 추가] 는 연동과 같은 창(`McpServerDialog`)을 「이 에이전트에 켜기」 칸과 함께 연다. 반영은 러너를 다시
 *   띄울 때다 — 저장 뒤 [지금 재시작] 이 그 자리에서 `agent.restart`(#869)를 부른다.
 *
 * 판정은 서버·오퍼레이터가 한다. 여기는 순서를 지키고 거절을 사람 말로 옮긴다.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AgentView, McpServerRow, OperatorView } from '@harkroom/shared';
import type { OperatorMcpEntry } from '@harkroom/shared/daemonProtocol';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { hasCapability } from '../../lib/capabilities';
import { ApiError } from '../../lib/api';
import { hasOperatorLocalSurface, listLocalMcpServers } from '../../lib/operatorLocal';
import { useLocalOperatorId } from '../../lib/useLocalOperatorId';
import { requestMcpFocus } from '../../lib/mcpFocus';
import { operatorNameOf } from '../../lib/operatorName';
import { McpServerDialog } from './McpServerDialog';
import { remoteMcpState } from '../../lib/mcpRemote';
import type { SectionId } from './sections';
import { useT } from '../../i18n/useT';
import { errorText } from '../../lib/errorText';

type Patch = { mcpServers: string[]; credentialScope?: 'personal'; invokeScope?: 'owner' };

/** 이 에이전트가 어디서 도는가. `unknown` 은 이 기기 오퍼레이터를 아직 못 읽었다. */
type Where = { kind: 'here' } | { kind: 'remote'; name: string } | { kind: 'none' } | { kind: 'unknown' };

/** 이 맥 정의의 인증이 사람 손을 기다리나 — 연동의 칸 주 버튼과 같은 판정. */
function authNeed(entry: OperatorMcpEntry): 'start' | 'again' | null {
  const st = entry.auth;
  if (!st || entry.transport === 'stdio') return null;
  if (st.state === 'expired' || st.state === 'rejected' || st.state === 'error') return 'again';
  if (st.state === 'none' && entry.oauth) return 'start';
  return null;
}

// 빨간 상태 글 바로 옆에 붙는다 — 강조색이면 둘이 한 덩어리로 읽혀(designer #1455 n4) 흐린 글+밑줄로 낮춘다.
const LINK = 'text-fg-muted underline underline-offset-2 hover:text-fg disabled:opacity-50';

export function AgentMcpSection({ agent, disabled, onUpdated, onOpenSection }: {
  agent: AgentView;
  disabled?: boolean;
  onUpdated: (next: AgentView) => void;
  /** 설정 화면의 섹션 바꾸기 — 있으면 「연동에서 … →」 링크를 그린다. */
  onOpenSection?: (section: SectionId) => void;
}) {
  const t = useT();
  const me = useActiveStore((s) => s.me);
  const canEdit = hasCapability(me, 'agent.privileged');
  const localOperatorId = useLocalOperatorId();
  const [registry, setRegistry] = useState<McpServerRow[] | 'error' | null>(null);
  /** 이 머신의 정의. `null` = 모른다(표면 없음·읽기 실패). */
  const [local, setLocal] = useState<OperatorMcpEntry[] | null>(null);
  const [operators, setOperators] = useState<OperatorView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  /** personal 서버를 붙이기 전 확인을 기다리는 PATCH. */
  const [pending, setPending] = useState<Patch | null>(null);
  /**
   * 이 에이전트가 든 팀의 이름 — 확인창이 열릴 때만 받는다. 팀 명단은 `GET /teams/:id` 에서만
   * 오므로(N+1) 늘 받아 두지 않는다. 못 받으면 조용히 빈다 — 확인 자체를 막을 사유는 아니다.
   */
  const [teamsOf, setTeamsOf] = useState<string[] | null>(null);
  useEffect(() => {
    if (!pending) { setTeamsOf(null); return; }
    let live = true;
    void (async () => {
      const c = getController();
      const rows = await c.listTeams();
      const names: string[] = [];
      for (const row of rows) {
        const { members } = await c.getTeam(row.id);
        if (members.some((m) => m.accountId === agent.id)) names.push(row.name);
      }
      if (live) setTeamsOf(names);
    })().catch(() => { if (live) setTeamsOf(null); });
    return () => { live = false; };
  }, [pending, agent.id]);
  const [adding, setAdding] = useState(false);

  const [restarted, setRestarted] = useState(false);
  const restartNow = () => void (async () => {
    setBusy(true); setError(null);
    try { await getController().restartAgent(agent.id); setRestarted(true); }
    catch { setError(t('agents.restart.failed')); }
    finally { setBusy(false); }
  })();

  const reload = useCallback(() => {
    // 약속 안에서 부른다 — 표면이 없는 컨트롤러(부분 가짜)에서도 동기 예외가 아니라 '읽지 못했다'다.
    void Promise.resolve().then(() => getController().mcpServers()).then(setRegistry).catch(() => setRegistry('error'));
    if (hasOperatorLocalSurface()) {
      void listLocalMcpServers().then((r) => setLocal(r.servers)).catch(() => setLocal(null));
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const assignedId = agent.assignment?.operatorId ?? null;
  // 원격 배정일 때만 이름이 필요하다 — 오퍼레이터 목록은 그때만 받는다.
  const remoteAssigned = !!assignedId && localOperatorId !== 'unknown' && assignedId !== localOperatorId;
  useEffect(() => {
    if (!remoteAssigned) return;
    let live = true;
    void Promise.resolve().then(() => getController().operators())
      .then((rows) => { if (live) setOperators(rows); }).catch(() => { if (live) setOperators(null); });
    return () => { live = false; };
  }, [remoteAssigned]);

  const where: Where = !assignedId
    ? { kind: 'none' }
    : localOperatorId === 'unknown'
      ? { kind: 'unknown' }
      : assignedId === localOperatorId
        ? { kind: 'here' }
        : { kind: 'remote', name: operatorNameOf(operators?.find((o) => o.id === assignedId)) ?? t('agents.mcp.where.otherOperator') };

  const mcpServers = agent.mcpServers ?? [];
  const off = busy || disabled;
  const definedHere = (n: string) => (local === null ? null : local.find((d) => d.name === n) ?? false);
  const kindOf = (n: string) => (Array.isArray(registry) ? registry.find((r) => r.name === n)?.credentialKind : undefined);

  const explain = (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.code === 'scope_invariant') return t('agents.scope.errInvariant');
      if (err.code === 'scope_widening') return t('agents.scope.errWidening');
      if (err.code === 'unknown_mcp_server') return t('agents.scope.errUnknownMcp');
      if (err.status === 403) return t('agents.mcp.errNotPrivileged');
    }
    return t('agents.scope.errFailed', { reason: errorText(err, t) });
  };

  /** 원격 배정이면 그 오퍼레이터(박동 상태의 출처). */
  const assignedOp = where.kind === 'remote' ? operators?.find((o) => o.id === assignedId) : undefined;
  const remoteState = (n: string) => (assignedOp ? remoteMcpState(assignedOp, n) : { kind: 'unknown' as const });

  /** 켜는 이름에 그 오퍼레이터의 정의가 없을(수 있을) 때 — 켜기는 하되 뜨지 않는다고 말한다(시안 v2 D12). */
  const warnFor = (n: string): string | null => {
    if (where.kind === 'here' && definedHere(n) === false) return t('agents.mcp.warnNoDefinitionHere', { name: n });
    if (where.kind === 'remote') {
      const st = remoteState(n);
      if (st.kind === 'defined') return null;
      if (st.kind === 'missing') return t('agents.mcp.warnMissingRemote', { name: n, host: where.name });
      return t('agents.mcp.warnNoDefinitionRemote', { name: n, host: where.name });
    }
    return null;
  };

  /** personal 이 섞였는데 에이전트가 아직 personal 이 아니면 확인부터 받는다. */
  const attach = async (names: string[], added?: string) => {
    const needsPersonal = names.some((n) => kindOf(n) === 'personal') && agent.credentialScope !== 'personal';
    const patch: Patch = needsPersonal ? { mcpServers: names, credentialScope: 'personal', invokeScope: 'owner' } : { mcpServers: names };
    if (needsPersonal) { setPending(patch); return; }
    onUpdated(await getController().updateAgent(agent.id, patch));
    setNotice(t('agents.mcp.restartNeeded'));
    if (added) setWarn(warnFor(added));
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null); setWarn(null); setRestarted(false);
    try { await fn(); } catch (e) { setError(explain(e)); } finally { setBusy(false); }
  };

  const toggle = (n: string, on: boolean) => void run(async () => {
    if (on) { await attach(mcpServers.filter((x) => x !== n)); return; }
    await attach([...mcpServers, n], n);
  });

  const confirmPending = () => {
    const patch = pending;
    if (!patch) return;
    setPending(null);
    void run(async () => {
      onUpdated(await getController().updateAgent(agent.id, patch));
      setNotice(t('agents.mcp.restartNeeded'));
    });
  };

  /** 창이 이름을 등록(·이 맥 정의)한 뒤 — 켜기를 골랐으면 붙인다. 등록한 kind 는 새 목록에서 읽는다. */
  const afterDialog = (result: { name: string; attach: boolean }) => {
    setAdding(false);
    reload();
    if (!result.attach || mcpServers.includes(result.name)) return;
    void run(async () => {
      const rows = await getController().mcpServers();
      setRegistry(rows);
      const next = [...mcpServers, result.name];
      const needsPersonal = rows.find((r) => r.name === result.name)?.credentialKind === 'personal' && agent.credentialScope !== 'personal';
      if (needsPersonal) { setPending({ mcpServers: next, credentialScope: 'personal', invokeScope: 'owner' }); return; }
      onUpdated(await getController().updateAgent(agent.id, { mcpServers: next }));
      setNotice(t('agents.mcp.restartNeeded'));
      if (where.kind === 'remote') setWarn(warnFor(result.name));
    });
  };

  const goIntegrations = (name?: string) => {
    // 원격 배정이면 그 호스트 칸으로 간다(designer #1455 n3).
    if (name) requestMcpFocus(name, where.kind === 'remote' && assignedId ? assignedId : undefined);
    onOpenSection?.('integrations');
  };
  const link = (label: string, name: string | undefined, testid: string) => onOpenSection && (
    <button type="button" className={LINK} data-testid={testid} onClick={() => goIntegrations(name)}>{label}</button>
  );

  /** 줄 끝에 붙는 상태 — 손이 필요할 때만. 정상은 `null`. */
  const status = (row: McpServerRow, on: boolean) => {
    if (where.kind === 'here') {
      const here = definedHere(row.name);
      if (here === false) {
        return (
          <>
            <span className={on ? 'text-danger' : 'text-fg-subtle'} data-testid={`agent-mcp-missing-${row.name}`}>
              {on ? t('agents.mcp.missingOnHere') : t('agents.mcp.missingHere')}
            </span>
            {on && link(t('agents.mcp.linkAdd'), row.name, `agent-mcp-link-${row.name}`)}
          </>
        );
      }
      const need = here ? authNeed(here) : null;
      if (need) {
        const word = here!.auth?.state === 'rejected' ? t('agents.mcp.authWord.rejected')
          : here!.auth?.state === 'expired' ? t('agents.mcp.authWord.expired')
            : here!.auth?.state === 'error' ? t('agents.mcp.authWord.error') : t('agents.mcp.authWord.needed');
        return (
          <>
            <span className={on ? 'text-danger' : 'text-fg-subtle'} data-testid={`agent-mcp-auth-${row.name}`}>{word}</span>
            {on && link(need === 'again' ? t('agents.mcp.linkSignInAgain') : t('agents.mcp.linkSignIn'), row.name, `agent-mcp-link-${row.name}`)}
          </>
        );
      }
      return null;
    }
    if (where.kind === 'remote') {
      // 그 호스트의 박동 상태로(#1451) — 박동이 없거나 그 이름이 실리지 않았으면 「상태 모름」.
      const st = remoteState(row.name);
      if (st.kind === 'missing') {
        return (
          <>
            <span className={on ? 'text-danger' : 'text-fg-subtle'} data-testid={`agent-mcp-missing-${row.name}`}>
              {on ? t('agents.mcp.missingOnRemote', { host: where.name }) : t('agents.mcp.missingRemote', { host: where.name })}
            </span>
            {on && link(t('agents.mcp.linkView'), row.name, `agent-mcp-link-${row.name}`)}
          </>
        );
      }
      if (st.kind === 'defined') {
        const a = st.entry.auth;
        const need = st.entry.transport !== 'stdio' && (a === 'rejected' || a === 'expired' || a === 'error' || (a === 'none' && st.entry.oauth));
        if (!need) return null;
        const word = a === 'rejected' ? t('agents.mcp.authWord.rejected') : a === 'expired' ? t('agents.mcp.authWord.expired')
          : a === 'error' ? t('agents.mcp.authWord.error') : t('agents.mcp.authWord.needed');
        return (
          <>
            <span className={on ? 'text-danger' : 'text-fg-subtle'} data-testid={`agent-mcp-auth-${row.name}`}>{word}</span>
            {on && link(t('agents.mcp.linkView'), row.name, `agent-mcp-link-${row.name}`)}
          </>
        );
      }
      if (!on) return null;
      return <span className="text-fg-subtle" data-testid={`agent-mcp-unknown-${row.name}`}>
        {st.kind === 'offline' ? t('agents.mcp.stateOffline') : t('agents.mcp.stateUnknown')}</span>;
    }
    if (where.kind === 'unknown' && on) {
      return <span className="text-fg-subtle" data-testid={`agent-mcp-unknown-${row.name}`}>{t('agents.mcp.stateUnknown')}</span>;
    }
    return null;
  };

  const head = (() => {
    if (where.kind === 'here') return { text: t('agents.mcp.where.here'), remote: false };
    if (where.kind === 'remote') return { text: t('agents.mcp.where.remote', { host: where.name }), remote: true };
    if (where.kind === 'none') return { text: t('agents.mcp.where.none'), remote: false };
    return null;
  })();

  return (
    <div className="mt-3" data-testid="agent-mcp-servers">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-meta text-fg-muted">
          {t('agents.scope.mcp')}
          {head && (
            <span data-testid="agent-mcp-where">
              {' · '}<span className="text-fg-subtle">{head.text}</span>
              {head.remote && <span className="ml-1 rounded-row border border-border px-1 text-fg-subtle">{t('agents.mcp.where.remoteTag')}</span>}
            </span>
          )}
        </div>
        <span className="flex items-center gap-2 text-meta">
          {where.kind !== 'none' && link(where.kind === 'remote' ? t('agents.mcp.linkView') : t('agents.mcp.linkManage'), undefined, 'agent-mcp-link-integrations')}
          <button
            className="rounded-row border border-border px-2 py-0.5 text-meta font-medium text-fg hover:bg-surface-sunken disabled:opacity-50"
            data-testid="agent-mcp-add-open"
            disabled={off}
            onClick={() => { setError(null); setAdding(true); }}
          >{t('agents.mcp.add')}</button>
        </span>
      </div>
      {registry === null && <p className="mt-1 text-meta text-fg-subtle">{t('agents.scope.mcpLoading')}</p>}
      {registry === 'error' && <p className="mt-1 text-meta text-danger">{t('agents.scope.mcpListFailed')}</p>}
      {Array.isArray(registry) && registry.length === 0 && (
        <p className="mt-1 text-meta text-fg-subtle">{t('agents.mcp.none')}</p>
      )}
      {Array.isArray(registry) && registry.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1">
          {registry.map((row) => {
            const on = mcpServers.includes(row.name);
            return (
              <li key={row.name} className="flex flex-wrap items-center gap-2 text-meta" data-testid={`agent-mcp-row-${row.name}`}>
                <label className="flex items-center gap-1 text-fg">
                  <input type="checkbox" aria-label={row.name} checked={on} disabled={off} onChange={() => toggle(row.name, on)} />
                  {row.name}
                </label>
                <span className="text-fg-subtle">{t(`mcpServers.kind.${row.credentialKind}`)}</span>
                {status(row, on)}
              </li>
            );
          })}
        </ul>
      )}
      {where.kind === 'remote' && <p className="mt-2 text-meta text-fg-subtle" data-testid="agent-mcp-remote-hint">{t('agents.mcp.remoteHint', { host: where.name })}</p>}
      {where.kind === 'none' && <p className="mt-2 text-meta text-fg-subtle">{t('agents.mcp.unassignedHint')}</p>}

      {adding && Array.isArray(registry) && (
        <McpServerDialog mode={{ kind: 'add' }} registry={registry} canEdit={canEdit}
          attach={{
            agentName: agent.displayName || agent.handle,
            remoteHost: where.kind === 'remote' ? where.name : null,
            narrowsToOwner: agent.credentialScope !== 'personal',
            remoteDefined: (n) => { const st = remoteState(n); return st.kind === 'defined' ? true : st.kind === 'missing' ? false : null; },
          }}
          onDone={afterDialog} onCancel={() => setAdding(false)} />
      )}

      {pending && (
        <div role="alertdialog" className="mt-2 rounded-row border border-warning-border bg-warning-surface p-2 text-meta text-warning" data-testid="agent-mcp-confirm-personal">
          <p>{t('agents.mcp.confirmPersonal')}</p>
          {/* 팀 소속을 함께 말한다(068) — owner 로 좁히면 팀 부름에서도 이 팀원 자리는 소유자만
              깨운다. 안 적으면 팀을 부른 남은 "왜 이 에이전트만 안 왔나"를 묻는다(#ops). */}
          {teamsOf && teamsOf.length > 0 && (
            <p className="mt-1" data-testid="agent-mcp-confirm-teams">
              {t('agents.mcp.confirmPersonalTeams', { teams: teamsOf.map((n) => `@${n}`).join(', ') })}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <button className="rounded-row border border-warning-border px-2 py-1 font-medium" data-testid="agent-mcp-confirm-yes" onClick={confirmPending}>{t('agents.mcp.confirmYes')}</button>
            <button className="rounded-row px-2 py-1" onClick={() => setPending(null)}>{t('agents.mcp.cancel')}</button>
          </div>
        </div>
      )}
      {warn && <p role="status" className="mt-2 text-meta text-warning" data-testid="agent-mcp-warn">{warn}</p>}
      {notice && (
        <div role="status" className="mt-2 flex flex-wrap items-center gap-2 text-meta text-fg-muted" data-testid="agent-mcp-notice">
          <span>{notice}</span>
          {/* 러너 config 는 기동 때 만든다 — 지금 쓰려면 갈아 띄운다(#869 `agent.restart`). 멈춰 둔 에이전트는 되살리지 않는다. */}
          {!agent.stopRequestedAt && !restarted && (
            <button className="rounded-row border border-border px-2 py-0.5 font-medium text-fg hover:bg-surface-sunken disabled:opacity-50"
              data-testid="agent-mcp-restart" disabled={off} onClick={restartNow}>{t('agents.mcp.restartNow')}</button>
          )}
          {restarted && <span>{t('agents.restart.sent')}</span>}
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-meta text-danger" data-testid="agent-mcp-error">{error}</p>}
    </div>
  );
}
