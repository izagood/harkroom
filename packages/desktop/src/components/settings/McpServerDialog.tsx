/**
 * MCP 서버 **추가·편집** 창 하나(MCP 설정 시안 v2 D3, 2026-10-21). 연동 › MCP 서버의 [+ 추가]·[이 맥에 추가]·
 * [편집] 이 같은 창을 연다.
 *
 * 무엇이 어디에 저장되는지를 창 머리의 범위 칩으로 먼저 말한다 — 이름·자격증명 종류는 **커뮤니티**(서버
 * 레지스트리), URL·Client ID 는 **이 맥의 오퍼레이터**(`operator/mcp-servers.json`)다. 이 맥의 모든 에이전트가
 * 그 정의를 같이 쓴다.
 *
 * - 편집에서 Client ID 칸을 비우면 **지금 값을 그대로 둔다**(security n1) — 비움을 「기본 앱으로」로 읽으면 전용
 *   앱으로 옮긴 사람이 같은 이름을 고칠 때 공용 앱으로 돌아가 토큰을 서로 밀어내던 문제가 되살아난다. 기본
 *   앱으로 돌아가는 것은 따로 누르는 「기본 앱으로 되돌리기」다.
 * - 회사 앱 Client ID 같은 값은 화면에 끝 4자리만 보인다. 정의에만 있고 공개 프리셋에는 없다.
 * - 권한(`agent.privileged`)이 없으면 커뮤니티에 새 이름을 등록할 수 없다 — 이미 있는 이름에 이 맥 정의를
 *   넣는 것은 된다(내 맥이다).
 * - 원격 정의에는 OAuth 콜백 포트 칸이 있다. Client ID 와 달리 비우면 **지운다**(남는 포트를 쓴다) — 값을 다 보여 주므로 비움이
 *   뜻하는 바가 모호하지 않다. 프리셋을 그대로 쓰는 동안에는 칸이 없다(slack 은 등록된 3118 고정).
 * - 연결 방식이 stdio 면 URL·Client ID 대신 명령·인자·환경 변수를 받는다. 저장을 누르면 Rust 가 OS 확인창에서 그 명령을
 *   보여 주고 묻는다(`mcp_stdio_confirm.rs`) — 웹뷰가 혼자 실행할 프로그램을 고르지 못한다는 경계(#431)를 지키는 자리다.
 *   목록은 env 값을 돌려주지 않으므로 편집에서 값을 비운 이름은 지금 값을 두는데, 명령·인자가 그대로일 때만이다.
 * - 에이전트 화면의 [+ 추가] 도 이 창을 연다(`attach`, 시안 v2 D4·D12). 「<에이전트> 에 켜기」 칸이 더해지고,
 *   그 에이전트가 **원격 오퍼레이터**에 배정돼 있으면 URL·Client ID 칸을 빼고(그 호스트에서 넣는다) 켜기를 꺼진 채
 *   시작한다 — 켜면 그 호스트에 정의가 생길 때까지 에이전트가 뜨지 않기 때문이다.
 */
import { useState } from 'react';
import type { McpServerRow } from '@harkroom/shared';
import type { OperatorMcpEntry, OperatorMcpRemoteDefinition } from '@harkroom/shared/daemonProtocol';
import { Overlay } from '../Overlay';
import { checkMcpEnvKey, checkMcpStdioCommand, sameMcpProgram, type McpStdioProblem } from '@harkroom/shared/mcpStdio';
import { MCP_PRESETS, presetForName } from '../../lib/mcpPresets';
import { setLocalMcpServer, setLocalMcpStdio } from '../../lib/operatorLocal';
import { getController } from '../../state/controller';
import { useLocale, useT } from '../../i18n/useT';
import { errorText } from '../../lib/errorText';

const NAME_RE = /^[a-z0-9-]{1,32}$/;

export type McpDialogMode =
  | { kind: 'add' }
  | { kind: 'define'; row: McpServerRow }
  | { kind: 'edit'; row: McpServerRow; entry: OperatorMcpEntry };

/** Client ID 를 화면에 보일 때는 끝 4자리만(시안 v2). */
export function clientIdTail(id: string): string {
  return id.length <= 4 ? id : `…${id.slice(-4)}`;
}

/**
 * 보낼 정의. 프리셋과 이름·URL 이 같으면 프리셋 정의(콜백 포트 포함)를 바탕으로 한다. 편집에서 칸이 비면
 * 지금 clientId 를 그대로 싣는다 — `revert` 일 때만 바탕(프리셋)의 값으로 돌아간다.
 */
export function buildMcpDefinition(input: {
  name: string; url: string; clientId: string; revert: boolean; entry?: OperatorMcpEntry; transport?: OperatorMcpRemoteDefinition['type'];
  /** 콜백 포트 칸의 값. `null` 은 비움(지운다), 없으면 칸이 없던 것이라 지금 값을 지킨다. */
  callbackPort?: number | null;
}): OperatorMcpRemoteDefinition {
  const url = input.url.trim();
  const preset = presetForName(input.name);
  const type: OperatorMcpRemoteDefinition['type'] = input.transport ?? (input.entry?.transport === 'sse' ? 'sse' : 'http');
  const base: OperatorMcpRemoteDefinition = preset && preset.definition.url === url && preset.definition.type === type ? preset.definition : { type, url };
  let oauth = base.oauth ? { ...base.oauth } : input.entry?.oauth ? {} : undefined;
  // 프리셋이 아닌 정의는 손으로 넣은 callbackPort 를 지킨다(목록이 실어 준다, PR3).
  if (input.callbackPort === undefined && !base.oauth?.callbackPort && input.entry?.oauthCallbackPort) oauth = { ...(oauth ?? {}), callbackPort: input.entry.oauthCallbackPort };
  if (typeof input.callbackPort === 'number') oauth = { ...(oauth ?? {}), callbackPort: input.callbackPort };
  const typed = input.clientId.trim();
  // 칸을 비우면 지금 Client ID 를 유지한다 — 단 **URL 이 그대로일 때만**. 옛 클라이언트는 새 서버의 것이 아니다
  // (security #1453 n4, 오퍼레이터 `localMcp.set` 과 같은 규칙).
  const sameUrl = input.entry !== undefined && input.entry.target === url;
  if (typed) oauth = { ...(oauth ?? {}), clientId: typed };
  else if (!input.revert && sameUrl && input.entry?.oauthClientId) oauth = { ...(oauth ?? {}), clientId: input.entry.oauthClientId };
  // 되돌리기는 프리셋 값을 **명시해** 보낸다 — 비워 보내면 오퍼레이터가 지금 값을 유지한다(PR3).
  else if (input.revert && preset?.definition.oauth?.clientId) oauth = { ...(oauth ?? {}), clientId: preset.definition.oauth.clientId };
  return oauth ? { ...base, oauth } : { type: base.type, url: base.url, ...(base.headers ? { headers: base.headers } : {}) };
}

/** 콜백 포트 칸 읽기. 빈 칸은 `null`, 받을 수 없는 값은 `'invalid'`. 파일에 이미 있는 값(`current`)은 범위 밖이어도 지킨다. */
export function parseCallbackPort(text: string, current?: number): number | null | 'invalid' {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d{1,5}$/.test(trimmed)) return 'invalid';
  const port = Number(trimmed);
  if (port === current) return port;
  return port >= 1024 && port <= 65535 ? port : 'invalid';
}

/** 인자 칸은 한 줄에 인자 하나다 — 앞뒤 공백과 빈 줄은 버리고, 줄 안의 공백은 그 인자의 일부다. */
export function parseMcpArgs(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

/** 환경 변수 한 줄. `existing` 이면 지금 정의에 있는 이름이라 값을 비우면 그대로 둔다. */
export interface McpEnvRow { id: number; key: string; value: string; existing: boolean }

export type McpEnvPlan = { env: Record<string, string>; keepEnv: string[] } | { problem: 'key' | 'codeLoading' | 'duplicate' | 'value' | 'retype'; key: string };

/** 줄들을 보낼 env·keepEnv 로 가른다. `programSame` 이 거짓이면 값을 비운 이름은 둘 수 없다. */
export function planMcpEnv(rows: readonly McpEnvRow[], programSame: boolean): McpEnvPlan {
  const env: Record<string, string> = {};
  const keepEnv: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key && !row.value) continue;
    if (seen.has(key)) return { problem: 'duplicate', key };
    seen.add(key);
    if (row.existing && !row.value) {
      if (!programSame) return { problem: 'retype', key };
      keepEnv.push(key);
      continue;
    }
    const bad = checkMcpEnvKey(key);
    if (bad) return { problem: bad === 'env-key' ? 'key' : 'codeLoading', key };
    if (!row.value) return { problem: 'value', key };
    env[key] = row.value;
  }
  return { env, keepEnv };
}

/** 에이전트 화면에서 열 때 — 그 에이전트에 켜기 칸과, 원격 배정이면 그 호스트 이름. */
export interface McpDialogAttach {
  agentName: string;
  /** 원격 오퍼레이터에 배정돼 있으면 그 이름. `null` 이면 이 맥(또는 배정 전)이라 이 맥 정의를 같이 넣는다. */
  remoteHost: string | null;
  /** 이 에이전트가 아직 personal 이 아니다 — personal 서버를 켜면 부를 수 있는 사람이 소유자로 좁혀진다. */
  narrowsToOwner: boolean;
  /**
   * 원격 호스트 박동상 그 이름의 정의가 있나 — `true` 면 「정의가 없으면 뜨지 않는다」를 띄우지 않는다(designer #1455 n2).
   * `null`·없음 = 모른다.
   */
  remoteDefined?: (name: string) => boolean | null;
}

export function McpServerDialog({ mode, registry, canEdit, attach, onDone, onCancel }: {
  mode: McpDialogMode;
  registry: McpServerRow[];
  canEdit: boolean;
  attach?: McpDialogAttach;
  onDone: (result: { name: string; attach: boolean }) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const first = MCP_PRESETS[0]!;
  const fixedRow = mode.kind === 'add' ? null : mode.row;
  const entry = mode.kind === 'edit' ? mode.entry : undefined;
  const initialPreset = fixedRow ? (presetForName(fixedRow.name)?.id ?? 'custom') : first.id;
  const [presetId, setPresetId] = useState(initialPreset);
  const [name, setName] = useState(fixedRow?.name ?? first.name);
  const stdioEntry = entry?.transport === 'stdio' ? entry : undefined;
  const [transport, setTransport] = useState<OperatorMcpEntry['transport']>(entry?.transport ?? 'http');
  const [url, setUrl] = useState((stdioEntry ? undefined : entry?.target) ?? (fixedRow ? (presetForName(fixedRow.name)?.definition.url ?? '') : first.definition.url));
  const [kind, setKind] = useState<McpServerRow['credentialKind']>(fixedRow?.credentialKind ?? first.credentialKind);
  const [clientId, setClientId] = useState('');
  const [callbackPort, setCallbackPort] = useState(entry?.oauthCallbackPort ? String(entry.oauthCallbackPort) : '');
  const [command, setCommand] = useState(stdioEntry?.target ?? '');
  const [argsText, setArgsText] = useState((stdioEntry?.args ?? []).join('\n'));
  const [envRows, setEnvRows] = useState<McpEnvRow[]>(() => (stdioEntry?.envKeys ?? []).map((key, id) => ({ id, key, value: '', existing: true })));
  const [nextEnvId, setNextEnvId] = useState((stdioEntry?.envKeys.length ?? 0) + 1);
  const [declined, setDeclined] = useState(false);
  const [revert, setRevert] = useState(false);
  const remoteOnly = !!attach?.remoteHost;
  // 이 맥(또는 배정 전)이면 미리 켠다(D4), 원격 배정이면 꺼진 채(D12).
  const [attachOn, setAttachOn] = useState(!!attach && !remoteOnly);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = presetForName(name);
  const presetClientId = preset?.definition.oauth?.clientId;
  const known = registry.find((r) => r.name === name.trim());
  const kindLocked = !!fixedRow || !!known;

  const pickPreset = (id: string) => {
    setPresetId(id);
    const p = MCP_PRESETS.find((x) => x.id === id);
    if (p) { setName(p.name); setUrl(p.definition.url); setKind(p.credentialKind); setTransport(p.definition.type); } else { setName(''); setUrl(''); setKind('personal'); }
    setClientId('');
    setCallbackPort('');
  };

  const placeholder = mode.kind === 'edit' && entry?.oauthClientId
    ? t('mcpServers.dialog.clientIdKeep')
    : presetClientId ? t('agents.mcp.clientIdPlaceholder') : t('mcpServers.dialog.clientIdDynamic');
  const current = entry?.oauthClientId;
  const ownApp = !!current && current !== presetClientId;

  const isStdio = !remoteOnly && transport === 'stdio';
  // 프리셋 주소를 그대로 쓰는 동안에는 칸이 없다 — 그 서비스에 등록된 값이 정해져 있다.
  const showCallbackPort = !remoteOnly && !isStdio && !(preset && preset.definition.url === url.trim());
  const showTransport = !remoteOnly && (presetId === 'custom' || !!stdioEntry);
  const stdioProgram = { command: command.trim(), args: parseMcpArgs(argsText) };
  const programSame = !!stdioEntry && sameMcpProgram(stdioProgram, { command: stdioEntry.target, args: stdioEntry.args });

  const stdioProblemText = (p: McpStdioProblem): string => {
    switch (p) {
      case 'command-empty': return t('mcpServers.stdio.errCommandEmpty');
      case 'command-shape': return t('mcpServers.stdio.errCommandShape');
      case 'text-invisible': return t('mcpServers.stdio.errInvisible');
      case 'text-spacing': return t('mcpServers.stdio.errSpacing');
      default: return t('mcpServers.stdio.errTooLong');
    }
  };

  /** stdio 저장. 이름 등록은 사람이 확인창에서 허락한 뒤에 한다 — 취소하면 아무것도 남지 않는다. */
  const saveStdio = async (n: string, plan: { env: Record<string, string>; keepEnv: string[] }): Promise<boolean> => {
    const language = locale.toLowerCase().startsWith('ko') ? 'ko' : 'en';
    const out = await setLocalMcpStdio(n, { ...stdioProgram, ...plan, locale: language });
    if (out.declined) { setDeclined(true); return false; }
    if (!registry.some((r) => r.name === n)) await getController().putMcpServer(n, kind);
    return true;
  };

  const submit = () => void (async () => {
    setError(null);
    setDeclined(false);
    const n = name.trim();
    if (!NAME_RE.test(n)) { setError(t('mcpServers.badName')); return; }
    let plan: { env: Record<string, string>; keepEnv: string[] } | null = null;
    if (isStdio) {
      const problem = checkMcpStdioCommand(stdioProgram.command, stdioProgram.args);
      if (problem) { setError(stdioProblemText(problem)); return; }
      const planned = planMcpEnv(envRows, programSame);
      if ('problem' in planned) {
        const key = planned.key;
        switch (planned.problem) {
          case 'key': setError(t('mcpServers.stdio.errEnvKey', { key })); break;
          case 'codeLoading': setError(t('mcpServers.stdio.errEnvCodeLoading', { key })); break;
          case 'duplicate': setError(t('mcpServers.stdio.errEnvDuplicate', { key })); break;
          case 'retype': setError(t('mcpServers.stdio.errEnvRetype', { key })); break;
          default: setError(t('mcpServers.stdio.errEnvValue', { key }));
        }
        return;
      }
      plan = planned;
    } else if (!remoteOnly && !/^https?:\/\//.test(url.trim())) { setError(t('agents.mcp.errUrl')); return; }
    const parsedPort = showCallbackPort ? parseCallbackPort(callbackPort, entry?.oauthCallbackPort) : undefined;
    if (parsedPort === 'invalid') { setError(t('mcpServers.dialog.errCallbackPort')); return; }
    if (!registry.some((r) => r.name === n) && !canEdit) { setError(t('mcpServers.dialog.needPrivilege')); return; }
    setBusy(true);
    try {
      if (plan) {
        if (!await saveStdio(n, plan)) return;
      } else {
        if (!registry.some((r) => r.name === n)) await getController().putMcpServer(n, kind);
        // 원격 배정 에이전트에서 열었으면 이 맥 정의는 넣지 않는다 — 그 에이전트는 그 호스트의 정의를 쓴다.
        const remoteTransport = transport === 'sse' ? 'sse' : 'http';
        if (!remoteOnly) await setLocalMcpServer(n, buildMcpDefinition({ name: n, url, clientId, revert, transport: remoteTransport, ...(entry && entry.transport !== 'stdio' ? { entry } : {}), ...(parsedPort !== undefined ? { callbackPort: parsedPort } : {}) }));
      }
      onDone({ name: n, attach: !!attach && attachOn });
    } catch (e) {
      setError(t('mcpServers.saveFailed', { reason: errorText(e, t) }));
    } finally {
      setBusy(false);
    }
  })();

  const field = 'min-w-0 rounded-row border border-border bg-surface px-2 py-1 text-meta text-fg disabled:bg-surface-sunken disabled:text-fg-muted';
  const title = mode.kind === 'edit'
    ? t('mcpServers.dialog.editTitle', { name: mode.row.name })
    : mode.kind === 'define' ? t('mcpServers.dialog.defineTitle', { name: mode.row.name }) : t('mcpServers.dialog.addTitle');

  return (
    <Overlay label={title} onClose={busy ? () => {} : onCancel} align="center" className="w-[min(520px,calc(100vw-32px))]">
      <div className="flex flex-col gap-3 p-4" data-testid="mcp-server-dialog">
        <h2 className="text-body font-semibold text-fg">{title}</h2>
        <div className="flex flex-wrap gap-1.5 text-meta">
          {mode.kind !== 'edit' && <span className="rounded-row bg-surface-sunken px-1.5 text-fg-muted">{t('mcpServers.dialog.scopeCommunity')}</span>}
          {!remoteOnly && <span className="rounded-row bg-surface-sunken px-1.5 text-fg-muted" data-testid="mcp-dialog-scope-here">{isStdio ? t('mcpServers.stdio.scopeHere') : t('mcpServers.dialog.scopeHere')}</span>}
          {attach && <span className="rounded-row bg-surface-sunken px-1.5 text-fg-muted">{t('mcpServers.dialog.scopeAttach', { agent: attach.agentName })}</span>}
        </div>
        {mode.kind === 'add' && (
          <label className="flex flex-col gap-1 text-meta text-fg">
            {t('agents.mcp.preset')}
            <select className={field} value={presetId} onChange={(e) => pickPreset(e.target.value)} disabled={busy}>
              {MCP_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              <option value="custom">{t('agents.mcp.custom')}</option>
            </select>
          </label>
        )}
        <div className="flex flex-wrap gap-2">
          <label className="flex w-32 flex-col gap-1 text-meta text-fg">
            {t('mcpServers.name')}
            <input className={`${field} font-mono`} value={name} disabled={busy || mode.kind !== 'add'}
              onChange={(e) => setName(e.target.value)} placeholder="github" data-testid="mcp-dialog-name" />
          </label>
          {showTransport && (
            <label className="flex flex-col gap-1 text-meta text-fg">
              {t('mcpServers.stdio.transport')}
              <select className={field} value={transport} disabled={busy} data-testid="mcp-dialog-transport"
                onChange={(e) => { setTransport(e.target.value as OperatorMcpEntry['transport']); setDeclined(false); }}>
                <option value="http">{t('mcpServers.stdio.transportHttp')}</option>
                <option value="sse">{t('mcpServers.stdio.transportSse')}</option>
                <option value="stdio">{t('mcpServers.stdio.transportStdio')}</option>
              </select>
            </label>
          )}
          {!remoteOnly && !isStdio && (
            <label className="flex min-w-40 flex-1 flex-col gap-1 text-meta text-fg">
              {t('agents.mcp.url')}
              <input className={field} value={url} disabled={busy} onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…/mcp" data-testid="mcp-dialog-url" />
            </label>
          )}
          <label className="flex flex-col gap-1 text-meta text-fg">
            {t('mcpServers.kindLabel')}
            <select className={field} value={known?.credentialKind ?? kind} disabled={busy || kindLocked}
              onChange={(e) => setKind(e.target.value as McpServerRow['credentialKind'])}>
              <option value="personal">{t('mcpServers.kind.personal')}</option>
              <option value="community">{t('mcpServers.kind.community')}</option>
            </select>
          </label>
        </div>
        {isStdio && <p className="text-meta text-fg-subtle" data-testid="mcp-dialog-stdio-kind-note">{t('mcpServers.stdio.kindNote')}</p>}
        {remoteOnly && (
          <p className="rounded-row border border-warning-border bg-warning-surface px-2.5 py-2 text-meta text-warning" data-testid="mcp-dialog-remote-note">
            {t('mcpServers.dialog.remoteNote', { agent: attach!.agentName, host: attach!.remoteHost! })}
          </p>
        )}
        {isStdio && (
          <div className="flex flex-col gap-3" data-testid="mcp-dialog-stdio">
            <label className="flex flex-col gap-1 text-meta text-fg">
              {t('mcpServers.stdio.command')}
              <input className={`${field} font-mono`} value={command} disabled={busy} onChange={(e) => setCommand(e.target.value)}
                placeholder="/usr/local/bin/example-mcp" autoComplete="off" spellCheck={false} data-testid="mcp-dialog-command" />
              <span className="text-fg-subtle">{t('mcpServers.stdio.commandNote')}</span>
            </label>
            <label className="flex flex-col gap-1 text-meta text-fg">
              {t('mcpServers.stdio.args')}
              <textarea className={`${field} resize-y font-mono`} rows={3} value={argsText} disabled={busy} onChange={(e) => setArgsText(e.target.value)}
                placeholder={t('mcpServers.stdio.argsPlaceholder')} autoComplete="off" spellCheck={false} data-testid="mcp-dialog-args" />
              <span className="text-fg-subtle">{t('mcpServers.stdio.argsNote')}</span>
            </label>
            <div className="flex flex-col gap-1 text-meta text-fg">
              <span>{t('mcpServers.stdio.env')}</span>
              {envRows.map((row) => {
                const patch = (next: Partial<McpEnvRow>) => setEnvRows((rows) => rows.map((r) => (r.id === row.id ? { ...r, ...next } : r)));
                return (
                  <div key={row.id} className="flex items-center gap-1.5" data-testid={`mcp-dialog-env-${row.id}`}>
                    <input className={`${field} w-40 font-mono`} value={row.key} disabled={busy || row.existing} aria-label={t('mcpServers.stdio.envKey')}
                      onChange={(e) => patch({ key: e.target.value })} placeholder="API_TOKEN" autoComplete="off" spellCheck={false} data-testid={`mcp-dialog-env-key-${row.id}`} />
                    <input className={`${field} flex-1 font-mono`} type="password" value={row.value} disabled={busy} aria-label={t('mcpServers.stdio.envValue')}
                      onChange={(e) => patch({ value: e.target.value })} autoComplete="off" spellCheck={false} data-testid={`mcp-dialog-env-value-${row.id}`}
                      placeholder={row.existing ? (programSame ? t('mcpServers.stdio.envKeep') : t('mcpServers.stdio.envRetype')) : t('mcpServers.stdio.envValue')} />
                    <button type="button" className="shrink-0 rounded-row px-1.5 py-0.5 text-fg-muted hover:bg-surface-sunken" disabled={busy}
                      aria-label={row.key.trim() ? t('mcpServers.stdio.envRemove', { key: row.key.trim() }) : t('mcpServers.stdio.envRemoveEmpty')} data-testid={`mcp-dialog-env-remove-${row.id}`}
                      onClick={() => setEnvRows((rows) => rows.filter((r) => r.id !== row.id))}>×</button>
                  </div>
                );
              })}
              <button type="button" className="self-start text-accent-text hover:underline" disabled={busy} data-testid="mcp-dialog-env-add"
                onClick={() => { setEnvRows((rows) => [...rows, { id: nextEnvId, key: '', value: '', existing: false }]); setNextEnvId((id) => id + 1); }}>
                {t('mcpServers.stdio.envAdd')}
              </button>
            </div>
            <p className="rounded-row border border-warning-border bg-warning-surface px-2.5 py-2 text-meta text-warning" data-testid="mcp-dialog-stdio-warn">
              {t('mcpServers.stdio.warn')}
            </p>
          </div>
        )}
        {!remoteOnly && !isStdio && <div className="flex flex-col gap-1 text-meta text-fg">
          <div className="flex items-start gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              {t('agents.mcp.clientId')}
              <input className={`${field} font-mono`} value={clientId} disabled={busy}
                onChange={(e) => { setClientId(e.target.value); setRevert(false); }}
                placeholder={placeholder} autoComplete="off" spellCheck={false} data-testid="mcp-dialog-client-id" />
            </label>
            {showCallbackPort && (
              <label className="flex w-40 shrink-0 flex-col gap-1">
                {t('mcpServers.dialog.callbackPort')}
                <input className={`${field} font-mono`} value={callbackPort} disabled={busy} inputMode="numeric"
                  onChange={(e) => setCallbackPort(e.target.value)} placeholder={t('mcpServers.dialog.callbackPortAuto')}
                  autoComplete="off" spellCheck={false} data-testid="mcp-dialog-callback-port" />
              </label>
            )}
          </div>
          {mode.kind === 'edit' && current && (
            <span className="text-fg-subtle" data-testid="mcp-dialog-client-current">
              {revert
                ? t('mcpServers.dialog.revertPending')
                : ownApp ? t('mcpServers.dialog.currentOwn', { tail: clientIdTail(current) }) : t('mcpServers.dialog.currentDefault')}
              {ownApp && presetClientId && !revert && (
                <>{' '}<button type="button" className="text-accent-text hover:underline" data-testid="mcp-dialog-revert"
                  onClick={() => { setRevert(true); setClientId(''); }}>{t('mcpServers.dialog.revert')}</button></>
              )}
            </span>
          )}
          <span className="text-fg-subtle">{t('mcpServers.dialog.noteOwnApp')}</span>
          <span className="text-fg-subtle">{t('mcpServers.dialog.notePkce')}</span>
          {showCallbackPort && <span className="text-fg-subtle" data-testid="mcp-dialog-callback-note">{t('mcpServers.dialog.noteCallbackPort')}</span>}
          {mode.kind === 'edit' && <span className="text-fg-subtle" data-testid="mcp-dialog-note-change">{showCallbackPort ? t('mcpServers.dialog.noteChangeWithPort') : t('mcpServers.dialog.noteChange')}</span>}
          {mode.kind === 'edit' && <span className="text-fg-subtle">{t('mcpServers.dialog.noteSignInAgain')}</span>}
        </div>}
        {attach && (
          <label className="flex items-start gap-1.5 text-meta text-fg">
            <input type="checkbox" className="mt-0.5" checked={attachOn} disabled={busy} data-testid="mcp-dialog-attach"
              onChange={(e) => setAttachOn(e.target.checked)} />
            <span>
              {t('mcpServers.dialog.attach', { agent: attach.agentName })}
              {remoteOnly
                ? attach.remoteDefined?.(name.trim()) !== true
                  && <span className="text-fg-subtle" data-testid="mcp-dialog-attach-remote-note"> — {t('mcpServers.dialog.attachRemoteNote', { host: attach.remoteHost! })}</span>
                : attach.narrowsToOwner && (known?.credentialKind ?? kind) === 'personal'
                  && <span className="text-fg-subtle"> — {t('mcpServers.dialog.attachPersonalNote')}</span>}
            </span>
          </label>
        )}
        {declined && <p className="text-meta text-fg-muted" data-testid="mcp-dialog-declined">{t('mcpServers.stdio.declined')}</p>}
        {error && <p role="alert" className="text-meta text-danger">{error}</p>}
        <div className="flex items-center justify-between gap-2">
          <span className="text-meta text-fg-subtle" data-testid="mcp-dialog-foot-note">
            {mode.kind === 'edit' ? ''
              // 이미 등록된 이름인데 켜기를 끈 채면 [켜기] 가 비활성이다 — 이유를 버튼 곁에 적는다(designer #1455 n1).
              : remoteOnly ? (known && !attachOn ? t('mcpServers.dialog.attachNeedsCheck') : '')
                : isStdio ? '' : t('mcpServers.dialog.afterSave')}
          </span>
          <span className="flex gap-2">
            <button type="button" className="rounded-row px-2 py-1 text-meta text-fg-muted hover:bg-surface-sunken" disabled={busy}
              onClick={onCancel}>{t('mcpServers.cancel')}</button>
            <button type="button" className="rounded-row bg-accent px-3 py-1 text-meta font-medium text-fg-on-strong disabled:opacity-50"
              disabled={busy || (remoteOnly && !!known && !attachOn)} onClick={submit} data-testid="mcp-dialog-submit">
              {mode.kind === 'edit' ? t('mcpServers.dialog.save')
                : remoteOnly
                  ? (known ? t('mcpServers.dialog.attachOnly') : attachOn ? t('mcpServers.dialog.registerAndAttach') : t('mcpServers.dialog.register'))
                  : attach && attachOn ? t('mcpServers.dialog.addAndAttach') : t('mcpServers.dialog.add')}
            </button>
          </span>
        </div>
      </div>
    </Overlay>
  );
}
