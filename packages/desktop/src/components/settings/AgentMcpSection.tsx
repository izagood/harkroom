/**
 * 에이전트 상세의 **MCP** 절 — 설정을 한 자리에서 끝낸다(MCP 설정 UI 1차, 2026-09-28).
 *
 * 전에는 세 군데였다: 서버 레지스트리(설정 › MCP servers), 이 머신의 `operator/mcp-servers.json`
 * (손으로), 에이전트의 체크. 게다가 personal 서버는 credentialScope 를 **먼저** 바꿔야 했고,
 * 정의 없는 이름을 켜면 오퍼레이터가 그 에이전트를 **띄우지 않았다**(`mcp_server_missing`).
 *
 * 여기서는:
 * - 줄마다 **이 머신에 정의가 있나**를 보인다(오퍼레이터 소켓, `listLocalMcpServers`). 정의가 없는
 *   이름은 켜지 못한다 — 켜면 다음 기동에서 에이전트가 조용히 안 뜬다.
 * - personal 서버를 켜면 "호출자가 소유자로 좁혀진다"를 확인받고 scope 를 **같은 PATCH** 로 바꾼다.
 * - [추가] 한 번에: 레지스트리 이름(없으면, agent.privileged — 없으면 막는다) → 이 머신 정의 →
 *   에이전트에 붙이기. 반영은 러너를 다시 띄울 때다(러너 config 는 기동 때 만든다) — 저장 뒤
 *   [지금 재시작] 이 그 자리에서 `agent.restart`(#869)를 부른다.
 *
 * 판정은 서버·오퍼레이터가 한다. 여기는 순서를 지키고 거절을 사람 말로 옮긴다.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AgentView, McpServerRow } from '@harkroom/shared';
import type { OperatorMcpEntry, OperatorMcpRemoteDefinition } from '@harkroom/shared/daemonProtocol';
import { getController } from '../../state/controller';
import { ApiError } from '../../lib/api';
import { forgetLocalMcpAuth, hasOperatorLocalSurface, listLocalMcpServers, localMcpAuthStatus, setLocalMcpServer, startLocalMcpAuth } from '../../lib/operatorLocal';
import { getExternalOpener } from '../../lib/openExternal';
import { MCP_PRESETS } from '../../lib/mcpPresets';
import { useT } from '../../i18n/useT';

const NAME = /^[a-z0-9-]{1,32}$/;

type Patch = { mcpServers: string[]; credentialScope?: 'personal'; invokeScope?: 'owner' };

export function AgentMcpSection({ agent, disabled, onUpdated }: {
  agent: AgentView;
  disabled?: boolean;
  onUpdated: (next: AgentView) => void;
}) {
  const t = useT();
  const [registry, setRegistry] = useState<McpServerRow[] | 'error' | null>(null);
  /** 이 머신의 정의. `null` = 모른다(표면 없음·읽기 실패) — 그때는 막지 않는다. */
  const [local, setLocal] = useState<OperatorMcpEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  const [presetId, setPresetId] = useState(MCP_PRESETS[0]!.id);
  const [name, setName] = useState(MCP_PRESETS[0]!.name);
  const [url, setUrl] = useState(MCP_PRESETS[0]!.definition.url);
  const [kind, setKind] = useState<'community' | 'personal'>(MCP_PRESETS[0]!.credentialKind);

  const [restarted, setRestarted] = useState(false);
  /** 브라우저 인증을 기다리는 이름. 오퍼레이터가 콜백을 받을 때까지 상태를 묻는다. */
  const [authWaiting, setAuthWaiting] = useState<string | null>(null);
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

  // 인증을 기다리는 동안 상태를 묻는다 — 끝나면(ok·error·expired) 목록을 다시 읽는다. 5분이면 오퍼레이터가 흐름을 닫는다.
  useEffect(() => {
    if (!authWaiting) return;
    const until = Date.now() + 5 * 60_000;
    const timer = setInterval(() => {
      void localMcpAuthStatus(authWaiting).then((st) => {
        if (st.state === 'pending' && Date.now() < until) return;
        setAuthWaiting(null);
        reload();
      }).catch(() => { setAuthWaiting(null); reload(); });
    }, 1500);
    return () => clearInterval(timer);
  }, [authWaiting, reload]);

  /**
   * 원격 MCP 인증(2026-09-30). 토큰은 오퍼레이터가 든다 — 계정 디렉터리마다 따로 인증하던 것을 여기 한 번으로.
   * 인가 url 은 오퍼레이터가 만들고(PKCE·state), 앱은 브라우저로 열기만 한다.
   */
  const signIn = (n: string) => void (async () => {
    setError(null);
    try {
      const { authUrl } = await startLocalMcpAuth(n);
      setAuthWaiting(n);
      reload();
      await getExternalOpener().open(authUrl);
    } catch (e) {
      setAuthWaiting(null);
      setError(t('agents.mcp.auth.failed', { reason: e instanceof Error ? e.message : String(e) }));
    }
  })();
  const signOut = (n: string) => void forgetLocalMcpAuth(n).then(reload, (e: unknown) => {
    setError(t('agents.mcp.auth.failed', { reason: e instanceof Error ? e.message : String(e) }));
  });

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
    return t('agents.scope.errFailed', { reason: err instanceof Error ? err.message : String(err) });
  };

  /** personal 이 섞였는데 에이전트가 아직 personal 이 아니면 확인부터 받는다. */
  const attach = async (names: string[]) => {
    const needsPersonal = names.some((n) => kindOf(n) === 'personal') && agent.credentialScope !== 'personal';
    const patch: Patch = needsPersonal ? { mcpServers: names, credentialScope: 'personal', invokeScope: 'owner' } : { mcpServers: names };
    if (needsPersonal) { setPending(patch); return; }
    onUpdated(await getController().updateAgent(agent.id, patch));
    setNotice(t('agents.mcp.restartNeeded'));
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null); setRestarted(false);
    try { await fn(); } catch (e) { setError(explain(e)); } finally { setBusy(false); }
  };

  const toggle = (n: string, on: boolean) => void run(async () => {
    if (on) { await attach(mcpServers.filter((x) => x !== n)); return; }
    if (definedHere(n) === false) { setError(t('agents.mcp.errNoDefinition', { name: n })); return; }
    await attach([...mcpServers, n]);
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

  const pickPreset = (id: string) => {
    setPresetId(id);
    const p = MCP_PRESETS.find((x) => x.id === id);
    if (p) { setName(p.name); setUrl(p.definition.url); setKind(p.credentialKind); }
    else { setName(''); setUrl(''); setKind('personal'); }
  };

  const add = () => void run(async () => {
    const n = name.trim();
    if (!NAME.test(n)) { setError(t('mcpServers.badName')); return; }
    if (!/^https?:\/\//.test(url.trim())) { setError(t('agents.mcp.errUrl')); return; }
    if (!hasOperatorLocalSurface()) { setError(t('agents.mcp.errNoLocal')); return; }
    const preset = MCP_PRESETS.find((x) => x.id === presetId);
    const definition: OperatorMcpRemoteDefinition = preset && preset.name === n && preset.definition.url === url.trim()
      ? preset.definition
      : { type: 'http', url: url.trim() };
    // 1) 레지스트리 이름 — 없을 때만. agent.privileged 가 없으면 403 → 여기서 멈춘다(막는다).
    const known = Array.isArray(registry) && registry.some((r) => r.name === n);
    if (!known) await getController().putMcpServer(n, kind);
    // 2) 이 머신의 정의 — 오퍼레이터가 쓴다.
    await setLocalMcpServer(n, definition);
    setAdding(false);
    reload();
    const rows = await getController().mcpServers();
    setRegistry(rows);
    // 3) 붙이기 — personal 이면 확인을 받는다(attach).
    if (!mcpServers.includes(n)) {
      const needsPersonal = rows.find((r) => r.name === n)?.credentialKind === 'personal' && agent.credentialScope !== 'personal';
      const next = [...mcpServers, n];
      if (needsPersonal) { setPending({ mcpServers: next, credentialScope: 'personal', invokeScope: 'owner' }); return; }
      onUpdated(await getController().updateAgent(agent.id, { mcpServers: next }));
    }
    setNotice(t('agents.mcp.restartNeeded'));
  });

  return (
    <div className="mt-3" data-testid="agent-mcp-servers">
      <div className="flex items-center justify-between">
        <div className="text-meta text-fg-muted">{t('agents.scope.mcp')}</div>
        {!adding && (
          <button
            className="rounded border border-border px-2 py-0.5 text-meta font-medium text-fg hover:bg-surface-sunken disabled:opacity-50"
            data-testid="agent-mcp-add-open"
            disabled={off}
            onClick={() => { setAdding(true); pickPreset(MCP_PRESETS[0]!.id); }}
          >{t('agents.mcp.add')}</button>
        )}
      </div>
      {registry === null && <p className="mt-1 text-meta text-fg-subtle">{t('agents.scope.mcpLoading')}</p>}
      {registry === 'error' && <p className="mt-1 text-meta text-danger">{t('agents.scope.mcpListFailed')}</p>}
      {Array.isArray(registry) && registry.length === 0 && !adding && (
        <p className="mt-1 text-meta text-fg-subtle">{t('agents.mcp.none')}</p>
      )}
      {Array.isArray(registry) && registry.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1">
          {registry.map((row) => {
            const on = mcpServers.includes(row.name);
            const here = definedHere(row.name);
            return (
              <li key={row.name} className="flex flex-wrap items-center gap-2 text-meta" data-testid={`agent-mcp-row-${row.name}`}>
                <label className="flex items-center gap-1 text-fg">
                  <input type="checkbox" aria-label={row.name} checked={on} disabled={off} onChange={() => toggle(row.name, on)} />
                  {row.name}
                </label>
                <span className="text-fg-subtle">{t(`mcpServers.kind.${row.credentialKind}`)}</span>
                {here === false && (
                  <span className={on ? 'text-danger' : 'text-fg-subtle'} data-testid={`agent-mcp-missing-${row.name}`}>
                    {on ? t('agents.mcp.missingOn') : t('agents.mcp.missing')}
                  </span>
                )}
                {here && <span className="text-fg-subtle">{t(here.source === 'operator' ? 'agents.mcp.definedOperator' : 'agents.mcp.definedClaude')}</span>}
                {here && here.transport !== 'stdio' && here.auth && (
                  <McpAuthBadge entry={here} on={on} waiting={authWaiting === row.name} disabled={off}
                    onSignIn={() => signIn(row.name)} onSignOut={() => signOut(row.name)} />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {adding && (
        <div className="mt-2 flex flex-col gap-2 rounded border border-border p-2" data-testid="agent-mcp-add">
          <label className="flex flex-col gap-1 text-meta text-fg">
            {t('agents.mcp.preset')}
            <select
              aria-label={t('agents.mcp.preset')}
              className="rounded border border-border bg-surface px-2 py-1 text-meta text-fg"
              value={presetId}
              onChange={(e) => pickPreset(e.target.value)}
            >
              {MCP_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              <option value="custom">{t('agents.mcp.custom')}</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <input aria-label={t('mcpServers.name')} className="w-32 rounded border border-border bg-surface px-2 py-1 text-meta text-fg"
              value={name} onChange={(e) => setName(e.target.value)} placeholder="name" />
            <input aria-label={t('agents.mcp.url')} className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-meta text-fg"
              value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" />
            <select aria-label={t('mcpServers.kindLabel')} className="rounded border border-border bg-surface px-2 py-1 text-meta text-fg"
              value={kind} onChange={(e) => setKind(e.target.value as 'community' | 'personal')}>
              <option value="personal">{t('mcpServers.kind.personal')}</option>
              <option value="community">{t('mcpServers.kind.community')}</option>
            </select>
          </div>
          <p className="text-meta text-fg-subtle">{t('agents.mcp.addNote')}</p>
          <div className="flex gap-2">
            <button className="rounded border border-border px-2 py-1 text-meta font-medium text-fg hover:bg-surface-sunken disabled:opacity-50"
              data-testid="agent-mcp-add-submit" disabled={off} onClick={add}>{t('agents.mcp.addSubmit')}</button>
            <button className="rounded px-2 py-1 text-meta text-fg-muted hover:bg-surface-sunken" disabled={off}
              onClick={() => setAdding(false)}>{t('agents.mcp.cancel')}</button>
          </div>
        </div>
      )}

      {pending && (
        <div role="alertdialog" className="mt-2 rounded border border-warning-border bg-warning-surface p-2 text-meta text-warning" data-testid="agent-mcp-confirm-personal">
          <p>{t('agents.mcp.confirmPersonal')}</p>
          {/* 팀 소속을 함께 말한다(068) — owner 로 좁히면 팀 부름에서도 이 팀원 자리는 소유자만
              깨운다. 안 적으면 팀을 부른 남은 "왜 이 에이전트만 안 왔나"를 묻는다(#udc). */}
          {teamsOf && teamsOf.length > 0 && (
            <p className="mt-1" data-testid="agent-mcp-confirm-teams">
              {t('agents.mcp.confirmPersonalTeams', { teams: teamsOf.map((n) => `@${n}`).join(', ') })}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <button className="rounded border border-warning-border px-2 py-1 font-medium" data-testid="agent-mcp-confirm-yes" onClick={confirmPending}>{t('agents.mcp.confirmYes')}</button>
            <button className="rounded px-2 py-1" onClick={() => setPending(null)}>{t('agents.mcp.cancel')}</button>
          </div>
        </div>
      )}
      {notice && (
        <div role="status" className="mt-2 flex flex-wrap items-center gap-2 text-meta text-fg-muted" data-testid="agent-mcp-notice">
          <span>{notice}</span>
          {/* 러너 config 는 기동 때 만든다 — 지금 쓰려면 갈아 띄운다(#869 `agent.restart`). 멈춰 둔 에이전트는 되살리지 않는다. */}
          {!agent.stopRequestedAt && !restarted && (
            <button className="rounded border border-border px-2 py-0.5 font-medium text-fg hover:bg-surface-sunken disabled:opacity-50"
              data-testid="agent-mcp-restart" disabled={off} onClick={restartNow}>{t('agents.mcp.restartNow')}</button>
          )}
          {restarted && <span>{t('agents.restart.sent')}</span>}
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-meta text-danger" data-testid="agent-mcp-error">{error}</p>}
    </div>
  );
}

/**
 * 원격 MCP 한 줄의 인증 상태와 버튼. `none` 이 곧 "인증 필요"는 아니다 — 인증을 요구하는지는 서버가
 * 안다. 정의에 `oauth` 가 적혀 있으면(slack 프리셋) 요구한다고 보고, 켠 줄에서는 경고로 보인다.
 */
function McpAuthBadge({ entry, on, waiting, disabled, onSignIn, onSignOut }: {
  entry: OperatorMcpEntry;
  on: boolean;
  waiting: boolean;
  disabled?: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  const t = useT();
  const st = waiting ? { state: 'pending' as const } : entry.auth!;
  const button = (label: string, action: () => void, testid: string) => (
    <button className="rounded border border-border px-1.5 py-0.5 text-meta font-medium text-fg hover:bg-surface-sunken disabled:opacity-50"
      data-testid={testid} disabled={disabled} onClick={action}>{label}</button>
  );
  const id = entry.name;
  if (st.state === 'ok') {
    return (
      <span className="flex items-center gap-1" data-testid={`agent-mcp-auth-${id}`}>
        <span className="text-fg-subtle">{t('agents.mcp.auth.ok')}</span>
        {button(t('agents.mcp.auth.forget'), onSignOut, `agent-mcp-auth-forget-${id}`)}
      </span>
    );
  }
  if (st.state === 'pending') {
    return <span className="text-fg-subtle" data-testid={`agent-mcp-auth-${id}`}>{t('agents.mcp.auth.pending')}</span>;
  }
  const text = st.state === 'expired'
    ? t('agents.mcp.auth.expired')
    : st.state === 'error'
      ? t('agents.mcp.auth.error', { reason: st.reason })
      : entry.oauth ? t('agents.mcp.auth.needed') : null;
  const warn = on && st.state !== 'none' ? true : on && entry.oauth;
  return (
    <span className="flex items-center gap-1" data-testid={`agent-mcp-auth-${id}`} title={t('agents.mcp.auth.note')}>
      {text && <span className={warn ? 'text-danger' : 'text-fg-subtle'}>{text}</span>}
      {button(st.state === 'none' ? t('agents.mcp.auth.start') : t('agents.mcp.auth.again'), onSignIn, `agent-mcp-auth-start-${id}`)}
    </span>
  );
}
