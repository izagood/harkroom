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
 * - 에이전트 화면의 [+ 추가] 도 이 창을 연다(`attach`, 시안 v2 D4·D12). 「<에이전트> 에 켜기」 칸이 더해지고,
 *   그 에이전트가 **원격 오퍼레이터**에 배정돼 있으면 URL·Client ID 칸을 빼고(그 호스트에서 넣는다) 켜기를 꺼진 채
 *   시작한다 — 켜면 그 호스트에 정의가 생길 때까지 에이전트가 뜨지 않기 때문이다.
 */
import { useState } from 'react';
import type { McpServerRow } from '@harkroom/shared';
import type { OperatorMcpEntry, OperatorMcpRemoteDefinition } from '@harkroom/shared/daemonProtocol';
import { Overlay } from '../Overlay';
import { MCP_PRESETS, presetForName } from '../../lib/mcpPresets';
import { setLocalMcpServer } from '../../lib/operatorLocal';
import { getController } from '../../state/controller';
import { useT } from '../../i18n/useT';
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
  name: string; url: string; clientId: string; revert: boolean; entry?: OperatorMcpEntry;
}): OperatorMcpRemoteDefinition {
  const url = input.url.trim();
  const preset = presetForName(input.name);
  const type: OperatorMcpRemoteDefinition['type'] = input.entry?.transport === 'sse' ? 'sse' : 'http';
  const base: OperatorMcpRemoteDefinition = preset && preset.definition.url === url ? preset.definition : { type, url };
  let oauth = base.oauth ? { ...base.oauth } : input.entry?.oauth ? {} : undefined;
  // 프리셋이 아닌 정의는 손으로 넣은 callbackPort 를 지킨다(목록이 실어 준다, PR3).
  if (!base.oauth?.callbackPort && input.entry?.oauthCallbackPort) oauth = { ...(oauth ?? {}), callbackPort: input.entry.oauthCallbackPort };
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

/** 에이전트 화면에서 열 때 — 그 에이전트에 켜기 칸과, 원격 배정이면 그 호스트 이름. */
export interface McpDialogAttach {
  agentName: string;
  /** 원격 오퍼레이터에 배정돼 있으면 그 이름. `null` 이면 이 맥(또는 배정 전)이라 이 맥 정의를 같이 넣는다. */
  remoteHost: string | null;
  /** 이 에이전트가 아직 personal 이 아니다 — personal 서버를 켜면 부를 수 있는 사람이 소유자로 좁혀진다. */
  narrowsToOwner: boolean;
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
  const first = MCP_PRESETS[0]!;
  const fixedRow = mode.kind === 'add' ? null : mode.row;
  const entry = mode.kind === 'edit' ? mode.entry : undefined;
  const initialPreset = fixedRow ? (presetForName(fixedRow.name)?.id ?? 'custom') : first.id;
  const [presetId, setPresetId] = useState(initialPreset);
  const [name, setName] = useState(fixedRow?.name ?? first.name);
  const [url, setUrl] = useState(entry?.target ?? (fixedRow ? (presetForName(fixedRow.name)?.definition.url ?? '') : first.definition.url));
  const [kind, setKind] = useState<McpServerRow['credentialKind']>(fixedRow?.credentialKind ?? first.credentialKind);
  const [clientId, setClientId] = useState('');
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
    if (p) { setName(p.name); setUrl(p.definition.url); setKind(p.credentialKind); } else { setName(''); setUrl(''); setKind('personal'); }
    setClientId('');
  };

  const placeholder = mode.kind === 'edit' && entry?.oauthClientId
    ? t('mcpServers.dialog.clientIdKeep')
    : presetClientId ? t('agents.mcp.clientIdPlaceholder') : t('mcpServers.dialog.clientIdDynamic');
  const current = entry?.oauthClientId;
  const ownApp = !!current && current !== presetClientId;

  const submit = () => void (async () => {
    setError(null);
    const n = name.trim();
    if (!NAME_RE.test(n)) { setError(t('mcpServers.badName')); return; }
    if (!remoteOnly && !/^https?:\/\//.test(url.trim())) { setError(t('agents.mcp.errUrl')); return; }
    if (!registry.some((r) => r.name === n) && !canEdit) { setError(t('mcpServers.dialog.needPrivilege')); return; }
    setBusy(true);
    try {
      if (!registry.some((r) => r.name === n)) await getController().putMcpServer(n, kind);
      // 원격 배정 에이전트에서 열었으면 이 맥 정의는 넣지 않는다 — 그 에이전트는 그 호스트의 정의를 쓴다.
      if (!remoteOnly) await setLocalMcpServer(n, buildMcpDefinition({ name: n, url, clientId, revert, ...(entry ? { entry } : {}) }));
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
          {!remoteOnly && <span className="rounded-row bg-surface-sunken px-1.5 text-fg-muted">{t('mcpServers.dialog.scopeHere')}</span>}
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
          {!remoteOnly && (
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-meta text-fg">
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
        {remoteOnly && (
          <p className="rounded-row border border-warning-border bg-warning-surface px-2.5 py-2 text-meta text-warning" data-testid="mcp-dialog-remote-note">
            {t('mcpServers.dialog.remoteNote', { agent: attach!.agentName, host: attach!.remoteHost! })}
          </p>
        )}
        {!remoteOnly && <label className="flex flex-col gap-1 text-meta text-fg">
          {t('agents.mcp.clientId')}
          <input className={`${field} font-mono`} value={clientId} disabled={busy}
            onChange={(e) => { setClientId(e.target.value); setRevert(false); }}
            placeholder={placeholder} autoComplete="off" spellCheck={false} data-testid="mcp-dialog-client-id" />
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
          {mode.kind === 'edit' && <span className="text-fg-subtle">{t('mcpServers.dialog.noteChange')}</span>}
          {mode.kind === 'edit' && <span className="text-fg-subtle">{t('mcpServers.dialog.noteSignInAgain')}</span>}
        </label>}
        {attach && (
          <label className="flex items-start gap-1.5 text-meta text-fg">
            <input type="checkbox" className="mt-0.5" checked={attachOn} disabled={busy} data-testid="mcp-dialog-attach"
              onChange={(e) => setAttachOn(e.target.checked)} />
            <span>
              {t('mcpServers.dialog.attach', { agent: attach.agentName })}
              {remoteOnly
                ? <span className="text-fg-subtle"> — {t('mcpServers.dialog.attachRemoteNote', { host: attach.remoteHost! })}</span>
                : attach.narrowsToOwner && (known?.credentialKind ?? kind) === 'personal'
                  && <span className="text-fg-subtle"> — {t('mcpServers.dialog.attachPersonalNote')}</span>}
            </span>
          </label>
        )}
        {error && <p role="alert" className="text-meta text-danger">{error}</p>}
        <div className="flex items-center justify-between gap-2">
          <span className="text-meta text-fg-subtle">{mode.kind === 'edit' || remoteOnly ? '' : t('mcpServers.dialog.afterSave')}</span>
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
