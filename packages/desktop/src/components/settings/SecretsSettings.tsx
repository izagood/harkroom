import { useCallback, useEffect, useState } from 'react';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { ApiError, type SecretAccessView, type SecretGrantView, type SecretView } from '../../lib/api';
import { useLocale, useT } from '../../i18n/useT';
import { ConfirmDialog } from '../ConfirmDialog';
import { Button, Field, Segmented, SettingsPage, TextInput } from './primitives';
import { ConnectorsSection } from './ConnectorsSection';

/**
 * 설정 › 나 › **비밀과 API** — 비밀 절(외부 API 권한 C안 P1, 스레드 07519d86 · designer v3 ①).
 *
 * 서버 REST(`secretRoutes.ts`, 085)는 이미 있었고 화면이 없었다. 키를 넣을 곳이 없으면 키는 채팅 평문으로
 * 돌고, 에이전트는 옛 글을 검색해 꺼낸다. 이 화면이 그 자리를 채운다.
 *
 * 지키는 것:
 * - **값은 보내기만 한다.** 넣은 뒤 다시 보여 주지 않고 「보기」도 없다(서버도 값·해시를 어떤 응답에도
 *   싣지 않는다). 넣기·바꾸기가 끝나면 입력 상태를 바로 비운다.
 * - **판정은 전부 서버다.** 부여는 소유자만, 지우기·거두기는 소유자나 admin — 화면은 버튼을 숨기는
 *   편의만 하고 거절은 서버 말을 사람 말로 옮긴다(`AgentGrantsSection` 머리 주석과 같은 이유).
 * - 지우기는 **발급처의 키 폐기가 아니다** — 확인창이 그렇게 말한다.
 *
 * 「쓰는 곳」(designer v3)은 지금은 파일로 받는 에이전트 수다. API 연결(P2)이 붙으면 그 연결 이름이 더해진다.
 */

type Expiry = 'none' | '30d' | '90d' | 'date';
type Panel = { id: string; kind: 'replace' | 'grants' | 'access' } | null;

const DAY = 86_400_000;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_BYTES = 64 * 1024;

function expiryIso(e: Expiry, date: string): string | null {
  if (e === 'none') return null;
  if (e === 'date') return date ? new Date(`${date}T23:59:59`).toISOString() : null;
  return new Date(Date.now() + (e === '30d' ? 30 : 90) * DAY).toISOString();
}

/** 파일을 base64 로. 64KB 상한은 서버도 잰다 — 여기서는 보내기 전에 사람에게 먼저 말한다. */
async function fileToBase64(f: File): Promise<string> {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function SecretsSettings() {
  const t = useT();
  const locale = useLocale();
  const me = useActiveStore((s) => s.me);
  const [state, setState] = useState<{ enabled: boolean; secrets: SecretView[] } | 'loading' | 'error'>('loading');
  const [adding, setAdding] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [deleting, setDeleting] = useState<SecretView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setState(await getController().listSecrets()); } catch { setState('error'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const explain = useExplain();
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true); setError(null);
    try { await fn(); await load(); return true; } catch (e) { setError(explain(e)); return false; } finally { setBusy(false); }
  };

  const secrets = typeof state === 'object' ? state.secrets : [];
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale);

  return (
    <SettingsPage section="secrets" description={t('secrets.description')}>
      {state === 'loading' && <p className="text-meta text-fg-muted">{t('secrets.loading')}</p>}
      {state === 'error' && <p role="alert" className="text-meta text-danger">{t('secrets.listFailed')}</p>}
      {typeof state === 'object' && !state.enabled && (
        <p className="mb-3 rounded bg-warning-surface px-3 py-2 text-meta text-warning" data-testid="secrets-disabled">{t('secrets.disabled')}</p>
      )}

      {typeof state === 'object' && (
        <section className="rounded border border-border p-3" data-testid="secrets">
          <div className="flex items-center gap-2">
            <span className="text-meta font-medium text-fg-muted">{t('secrets.heading')}</span>
            <span className="text-meta text-fg-subtle">{t('secrets.count', { n: String(secrets.length) })}</span>
            {state.enabled && !adding && (
              <span className="ml-auto"><Button onClick={() => { setAdding(true); setError(null); }} disabled={busy}>{t('secrets.add')}</Button></span>
            )}
          </div>

          {adding && (
            <CreateForm
              busy={busy}
              onCancel={() => setAdding(false)}
              onSubmit={async (body) => { if (await run(async () => { await getController().createSecret(body); })) setAdding(false); }}
            />
          )}

          {secrets.length === 0 && !adding && <p className="mt-2 text-meta text-fg-subtle" data-testid="secrets-none">{t('secrets.none')}</p>}

          <ul className="mt-2 space-y-1">
            {secrets.map((s) => {
              const expired = s.expiresAt !== null && Date.parse(s.expiresAt) <= Date.now();
              const mine = s.ownerAccountId === me?.id;
              const open = panel?.id === s.id ? panel.kind : null;
              const toggle = (kind: NonNullable<Panel>['kind']) => { setError(null); setPanel(open === kind ? null : { id: s.id, kind }); };
              return (
                <li key={s.id} className="rounded border border-border px-2 py-1 text-meta" data-testid={`secret-${s.name}`}>
                  <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${expired ? 'text-fg-subtle' : 'text-fg'}`}>
                    <span className="font-mono font-medium">{s.name}</span>
                    <span className="rounded border border-border px-1 text-fg-muted">{s.kind === 'file' ? t('secrets.kindFile') : t('secrets.kindText')}</span>
                    {s.filename && <span className="font-mono">{s.filename}</span>}
                    {s.description && <span className="text-fg-subtle">{s.description}</span>}
                    <span className="text-fg-subtle">
                      {s.grantCount > 0 ? t('secrets.usedBy', { n: String(s.grantCount) }) : t('secrets.unused')}
                    </span>
                    {expired
                      ? <span className="rounded bg-warning-surface px-1 text-warning">{t('secrets.expired', { when: date(s.expiresAt as string) })}</span>
                      : <span className="text-fg-subtle">{s.expiresAt ? t('secrets.until', { when: date(s.expiresAt) }) : t('secrets.noExpiry')}</span>}
                    <span className="ml-auto flex flex-wrap gap-1">
                      {mine && state.enabled && <SmallButton onClick={() => toggle('replace')} disabled={busy} pressed={open === 'replace'}>{t('secrets.replace')}</SmallButton>}
                      <SmallButton onClick={() => toggle('grants')} disabled={busy} pressed={open === 'grants'}>{t('secrets.grants')}</SmallButton>
                      <SmallButton onClick={() => toggle('access')} disabled={busy} pressed={open === 'access'}>{t('secrets.access')}</SmallButton>
                      <SmallButton onClick={() => setDeleting(s)} disabled={busy} danger ariaLabel={t('secrets.deleteAria', { name: s.name })}>{t('secrets.delete')}</SmallButton>
                    </span>
                  </div>
                  {open === 'replace' && (
                    <ReplaceForm secret={s} busy={busy} onCancel={() => setPanel(null)}
                      onSubmit={async (body) => { if (await run(async () => { await getController().replaceSecretValue(s.id, body); })) setPanel(null); }} />
                  )}
                  {open === 'grants' && <GrantsPanel secret={s} canGrant={mine && !expired} expiredMine={mine && expired} onChanged={load} />}
                  {open === 'access' && <AccessPanel secret={s} />}
                </li>
              );
            })}
          </ul>
          {error && <p role="alert" className="mt-2 text-meta text-danger" data-testid="secrets-error">{error}</p>}
        </section>
      )}

      {/* API 연결(P4b, designer v3 ②) — 비밀을 가리키므로 같은 페이지, 비밀 절 아래(D1). */}
      {typeof state === 'object' && <ConnectorsSection secrets={secrets} enabled={state.enabled} onChanged={load} />}

      {deleting && (
        <ConfirmDialog
          title={t('secrets.deleteTitle', { name: deleting.name })}
          detail={deleting.grantCount > 0
            ? t('secrets.deleteDetailUsed', { n: String(deleting.grantCount) })
            : t('secrets.deleteDetail')}
          detailKind="note"
          confirmLabel={t('secrets.delete')}
          cancelLabel={t('secrets.cancel')}
          danger
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const s = deleting;
            setDeleting(null);
            if (panel?.id === s.id) setPanel(null);
            void run(() => getController().deleteSecret(s.id));
          }}
        />
      )}
    </SettingsPage>
  );
}

/** 서버 거절 코드 → 사람 말. 값은 되비추지 않는다(서버 메시지에도 값은 없다). */
function useExplain() {
  const t = useT();
  return (err: unknown): string => {
    if (err instanceof ApiError) {
      switch (err.code) {
        case 'name_taken': return t('secrets.errNameTaken');
        case 'secret_in_description': return t('secrets.errInDescription');
        case 'bad_value': return t('secrets.errBadValue');
        case 'secret_store_disabled': return t('secrets.disabled');
        case 'owner_only': return t('secrets.errOwnerOnly');
        case 'secret_expired': return t('secrets.errExpired');
        case 'not_assigned': return t('secrets.errNotAssigned');
        default: break;
      }
      if (err.status === 403) return t('secrets.errForbidden');
    }
    return t('secrets.errFailed', { reason: err instanceof Error ? err.message : String(err) });
  };
}

function SmallButton({ children, onClick, disabled, danger, pressed, ariaLabel }: {
  children: React.ReactNode; onClick(): void; disabled?: boolean; danger?: boolean; pressed?: boolean; ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className={`rounded border border-border px-2 py-0.5 text-meta disabled:opacity-50 ${danger ? 'text-fg hover:text-danger' : 'text-fg hover:bg-surface-sunken'} ${pressed ? 'bg-surface-sunken' : ''}`}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** 값 칸 — 텍스트는 가린 입력, 파일은 고르기. 상위가 받는 것은 서버 몸체 그대로다. */
function ValueInput({ kind, value, onValue, onFile, disabled }: {
  kind: 'text' | 'file'; value: string; onValue(v: string): void; onFile(f: File | null): void; disabled?: boolean;
}) {
  const t = useT();
  if (kind === 'text') {
    return (
      <input
        type="password"
        // `off` 는 password 칸에서 엔진이 무시한다 — 비밀번호 관리자의 저장·채우기 제안을 줄이는 값은 이것이다.
        autoComplete="new-password"
        spellCheck={false}
        aria-label={t('secrets.value')}
        className="w-full rounded border border-border bg-field px-3 py-2 font-mono text-fg"
        value={value}
        disabled={disabled}
        onChange={(e) => onValue(e.target.value)}
      />
    );
  }
  return (
    <input
      type="file"
      aria-label={t('secrets.file')}
      className="text-meta text-fg"
      disabled={disabled}
      onChange={(e) => onFile(e.target.files?.[0] ?? null)}
    />
  );
}

type CreateBody = Parameters<ReturnType<typeof getController>['createSecret']>[0];

function CreateForm({ busy, onSubmit, onCancel }: { busy: boolean; onSubmit(b: CreateBody): Promise<void>; onCancel(): void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'text' | 'file'>('text');
  const [value, setValue] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState('');
  const [expiry, setExpiry] = useState<Expiry>('90d');
  const [date, setDate] = useState('');

  const nameBad = name !== '' && !NAME_RE.test(name);
  const tooBig = kind === 'file' ? (file?.size ?? 0) > MAX_BYTES : new TextEncoder().encode(value).length > MAX_BYTES;
  const hasValue = kind === 'file' ? file !== null : value !== '';
  const ready = NAME_RE.test(name) && hasValue && !tooBig && !(expiry === 'date' && !date);

  const submit = async () => {
    const body: CreateBody = {
      name, kind, description: description.trim(), expiresAt: expiryIso(expiry, date),
      ...(kind === 'text' ? { value } : { valueBase64: await fileToBase64(file as File), filename: (file as File).name }),
    };
    // 보낸 순간 값은 이 화면에서 지운다 — 실패해도 다시 붙여 넣게 한다(값을 상태에 오래 두지 않는다).
    setValue(''); setFile(null);
    await onSubmit(body);
  };

  return (
    <div className="mt-2 space-y-3 rounded border border-border bg-surface-sunken p-3" data-testid="secret-create">
      <Field label={t('secrets.name')} hint={nameBad ? t('secrets.nameBad') : t('secrets.nameHint')} tone={nameBad ? 'warning' : 'muted'}>
        <TextInput value={name} onChange={(v) => setName(v.trim())} placeholder="api-token" disabled={busy} />
      </Field>
      <div>
        <span className="text-meta text-fg">{t('secrets.kind')}</span>
        <Segmented label={t('secrets.kind')} value={kind} onChange={(v) => { setKind(v as 'text' | 'file'); setValue(''); setFile(null); }}
          options={[{ value: 'text', label: t('secrets.kindText') }, { value: 'file', label: t('secrets.kindFile') }]} />
      </div>
      <Field label={kind === 'text' ? t('secrets.value') : t('secrets.file')} hint={tooBig ? t('secrets.tooBig') : kind === 'text' ? `${t('secrets.valueHint')} ${t('secrets.multilineHint')}` : t('secrets.valueHint')} tone={tooBig ? 'warning' : 'muted'}>
        <ValueInput kind={kind} value={value} onValue={setValue} onFile={setFile} disabled={busy} />
      </Field>
      <Field label={t('secrets.descriptionLabel')} hint={t('secrets.descriptionHint')}>
        <TextInput value={description} onChange={setDescription} disabled={busy} />
      </Field>
      <div>
        <span className="text-meta text-fg">{t('secrets.expiry')}</span>
        <Segmented label={t('secrets.expiry')} value={expiry} onChange={(v) => setExpiry(v as Expiry)} options={[
          { value: 'none', label: t('secrets.expiryNone') }, { value: '30d', label: t('secrets.expiry30d') },
          { value: '90d', label: t('secrets.expiry90d') }, { value: 'date', label: t('secrets.expiryDate') },
        ]} />
        {expiry === 'date' && (
          <input type="date" aria-label={t('secrets.expiryDate')} className="mt-1 rounded border border-border bg-field px-2 py-1 text-meta text-fg"
            value={date} onChange={(e) => setDate(e.target.value)} disabled={busy} />
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => void submit()} disabled={busy || !ready}>{t('secrets.confirmAdd')}</Button>
        <Button onClick={onCancel} disabled={busy}>{t('secrets.cancel')}</Button>
      </div>
    </div>
  );
}

function ReplaceForm({ secret, busy, onSubmit, onCancel }: {
  secret: SecretView; busy: boolean; onSubmit(b: { value?: string; valueBase64?: string }): Promise<void>; onCancel(): void;
}) {
  const t = useT();
  const [value, setValue] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const tooBig = secret.kind === 'file' ? (file?.size ?? 0) > MAX_BYTES : new TextEncoder().encode(value).length > MAX_BYTES;
  const ready = (secret.kind === 'file' ? file !== null : value !== '') && !tooBig;
  const submit = async () => {
    const body = secret.kind === 'text' ? { value } : { valueBase64: await fileToBase64(file as File) };
    setValue(''); setFile(null);
    await onSubmit(body);
  };
  return (
    <div className="mt-2 space-y-2 rounded border border-border bg-surface-sunken p-2" data-testid="secret-replace">
      <Field label={t('secrets.newValue')} hint={tooBig ? t('secrets.tooBig') : secret.kind === 'text' ? `${t('secrets.replaceHint')} ${t('secrets.multilineHint')}` : t('secrets.replaceHint')} tone={tooBig ? 'warning' : 'muted'}>
        <ValueInput kind={secret.kind} value={value} onValue={setValue} onFile={setFile} disabled={busy} />
      </Field>
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => void submit()} disabled={busy || !ready}>{t('secrets.confirmReplace')}</Button>
        <Button onClick={onCancel} disabled={busy}>{t('secrets.cancel')}</Button>
      </div>
    </div>
  );
}

/** 파일로 받을 에이전트(`secret.mount`). 부여는 소유자만 — 서버 owner_only 와 같다. */
function GrantsPanel({ secret, canGrant, expiredMine, onChanged }: { secret: SecretView; canGrant: boolean; expiredMine: boolean; onChanged(): Promise<void> }) {
  const t = useT();
  const locale = useLocale();
  const accounts = useActiveStore((s) => s.accounts);
  const channels = useActiveStore((s) => s.channels);
  const [rows, setRows] = useState<SecretGrantView[] | 'loading' | 'error'>('loading');
  const [agentId, setAgentId] = useState('');
  const [operator, setOperator] = useState<'current' | 'any'>('current');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<SecretGrantView | null>(null);
  const explain = useExplain();

  const load = useCallback(async () => {
    try { setRows(await getController().listSecretGrants(secret.id)); } catch { setRows('error'); }
  }, [secret.id]);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); await onChanged(); } catch (e) { setError(explain(e)); } finally { setBusy(false); }
  };
  const handle = (id: string) => accounts[id]?.handle ?? id.slice(0, 8);
  const me = useActiveStore((s) => s.me);
  // 남의 에이전트에게 주면 값이 **그 사람 머신의 오퍼레이터**에 파일로 떨어진다(security M1) — 목록을 나누고 경고한다.
  // 서버는 아직 kind 만 본다. 막을지는 P2 에서 정한다.
  const agents = Object.values(accounts).filter((a) => a.kind === 'agent').sort((a, b) => a.handle.localeCompare(b.handle));
  const mineAgents = agents.filter((a) => a.ownerAccountId === me?.id);
  const otherAgents = agents.filter((a) => a.ownerAccountId !== me?.id);
  const picked = agentId ? accounts[agentId] : undefined;
  const pickedOther = picked !== undefined && picked.ownerAccountId !== me?.id;

  return (
    <div className="mt-2 rounded border border-border bg-surface-sunken p-2" data-testid="secret-grants">
      <p className="text-meta text-fg-subtle">{t('secrets.grantsNote')}</p>
      {rows === 'loading' && <p className="mt-1 text-meta text-fg-muted">{t('secrets.loading')}</p>}
      {rows === 'error' && <p role="alert" className="mt-1 text-meta text-danger">{t('secrets.listFailed')}</p>}
      {Array.isArray(rows) && rows.length === 0 && <p className="mt-1 text-meta text-fg-subtle">{t('secrets.grantsNone')}</p>}
      {Array.isArray(rows) && rows.length > 0 && (
        <ul className="mt-1 space-y-1">
          {rows.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-fg" data-testid={`secret-grant-${handle(g.agentId)}`}>
              <span className="font-medium">@{handle(g.agentId)}</span>
              <span className="text-fg-subtle">
                {g.channelId ? `#${channels.find((c) => c.id === g.channelId)?.name ?? g.channelId.slice(0, 8)}` : t('secrets.allChannels')}
                {' · '}{g.operatorId ? t('secrets.boundOperator') : t('secrets.anyOperator')}
                {' · '}{t('secrets.grantedOn', { when: new Date(g.grantedAt).toLocaleDateString(locale) })}
              </span>
              {g.suspendedAt && <span className="rounded bg-warning-surface px-1 text-warning">{t('secrets.suspended', { reason: g.suspendReason ?? '' })}</span>}
              <span className="ml-auto"><SmallButton onClick={() => setRevoking(g)} disabled={busy} danger ariaLabel={t('secrets.revokeAria', { handle: handle(g.agentId) })}>{t('secrets.revoke')}</SmallButton></span>
            </li>
          ))}
        </ul>
      )}
      {canGrant ? (
        <>
        {/* 경고는 읽는 순서대로 주기 폼 바로 위(designer n4). */}
        <p className="mt-2 text-meta text-warning" data-testid="secret-grants-all-channels">{t('secrets.allChannelsWarn')}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <select aria-label={t('secrets.grantAgent')} className="rounded border border-border bg-field px-2 py-1 text-meta text-fg" value={agentId} disabled={busy} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">{t('secrets.grantAgentPick')}</option>
            {mineAgents.length > 0 && (
              <optgroup label={t('secrets.agentsMine')}>
                {mineAgents.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
              </optgroup>
            )}
            {otherAgents.length > 0 && (
              <optgroup label={t('secrets.agentsOthers')}>
                {otherAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {t('secrets.agentOther', { handle: a.handle, owner: a.ownerAccountId ? handle(a.ownerAccountId) : '?' })}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <select aria-label={t('secrets.grantOperator')} className="rounded border border-border bg-field px-2 py-1 text-meta text-fg" value={operator} disabled={busy} onChange={(e) => setOperator(e.target.value as 'current' | 'any')}>
            <option value="current">{t('secrets.operatorCurrent')}</option>
            <option value="any">{t('secrets.operatorAny')}</option>
          </select>
          <SmallButton disabled={busy || !agentId} onClick={() => void run(async () => {
            await getController().putSecretGrant(secret.id, { agentId, channelId: null, operator });
            setAgentId('');
          })}>{t('secrets.grant')}</SmallButton>
          {pickedOther && (
            <p className="w-full text-meta text-warning" data-testid="secret-grant-other-warn">
              {t('secrets.otherAgentWarn', { handle: picked.handle, owner: picked.ownerAccountId ? handle(picked.ownerAccountId) : '?' })}
            </p>
          )}
          {operator === 'any' && <p className="w-full text-meta text-warning" data-testid="secret-grant-any-warn">{t('secrets.anyOperatorWarn')}</p>}
        </div>
        </>
      ) : (
        // 내 비밀이 만료돼서 못 주는 것과 남의 비밀이라 못 주는 것은 고칠 길이 다르다(designer n3).
        <p className="mt-2 text-meta text-fg-subtle">{expiredMine ? t('secrets.grantExpiredMine') : t('secrets.grantOwnerOnly')}</p>
      )}
      {error && <p role="alert" className="mt-1 text-meta text-danger" data-testid="secret-grants-error">{error}</p>}
      {revoking && (
        <ConfirmDialog
          title={t('secrets.revokeTitle', { handle: handle(revoking.agentId), name: secret.name })}
          detail={t('secrets.revokeDetail')}
          detailKind="note"
          confirmLabel={t('secrets.revoke')}
          cancelLabel={t('secrets.cancel')}
          danger
          busy={busy}
          onCancel={() => setRevoking(null)}
          onConfirm={() => { const g = revoking; setRevoking(null); void run(() => getController().deleteSecretGrant(secret.id, g.id)); }}
        />
      )}
    </div>
  );
}

/**
 * 접근 기록의 「결과」를 사람 말로(designer n2). 서버 코드를 그대로 두지 않는다 — `api:<연결> <METHOD> <경로>` 는 API 호출로
 * 키를 건넨 줄(P3)이고, 나머지 거절 이유는 아는 것만 옮기고 모르는 것은 코드 그대로 둔다.
 */
function accessText(t: ReturnType<typeof useT>, r: SecretAccessView): string {
  if (r.result === 'granted') {
    if (r.reason?.startsWith('api:')) return t('secrets.accessApi', { what: r.reason.slice(4) });
    return t('secrets.accessMounted');
  }
  const known: Record<string, string> = {
    not_granted: t('secrets.why.notGranted'), wrong_channel: t('secrets.why.wrongChannel'), wrong_operator: t('secrets.why.wrongOperator'),
    grant_suspended: t('secrets.why.suspended'), secret_expired: t('secrets.why.expired'), rate_limited: t('secrets.why.rateLimited'),
    lease_invalid: t('secrets.why.lease'), owner_inactive: t('secrets.why.ownerInactive'),
  };
  return t('secrets.accessDenied', { why: (r.reason && known[r.reason]) ?? r.reason ?? '?' });
}

function AccessPanel({ secret }: { secret: SecretView }) {
  const t = useT();
  const locale = useLocale();
  const accounts = useActiveStore((s) => s.accounts);
  const channels = useActiveStore((s) => s.channels);
  const [rows, setRows] = useState<SecretAccessView[] | 'loading' | 'error'>('loading');
  useEffect(() => {
    let live = true;
    getController().listSecretAccess(secret.id).then((r) => { if (live) setRows(r); }, () => { if (live) setRows('error'); });
    return () => { live = false; };
  }, [secret.id]);
  return (
    <div className="mt-2 overflow-x-auto rounded border border-border bg-surface-sunken p-2" data-testid="secret-access">
      {rows === 'loading' && <p className="text-meta text-fg-muted">{t('secrets.loading')}</p>}
      {rows === 'error' && <p role="alert" className="text-meta text-danger">{t('secrets.listFailed')}</p>}
      {Array.isArray(rows) && rows.length === 0 && <p className="text-meta text-fg-subtle">{t('secrets.accessNone')}</p>}
      {Array.isArray(rows) && rows.length > 0 && (
        <table className="w-full text-left text-meta">
          <thead className="text-fg-subtle">
            <tr><th className="pr-3 font-medium">{t('secrets.accessAt')}</th><th className="pr-3 font-medium">{t('secrets.accessWho')}</th><th className="pr-3 font-medium">{t('secrets.accessWhere')}</th><th className="font-medium">{t('secrets.accessResult')}</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border text-fg">
                <td className="pr-3">{new Date(r.at).toLocaleString(locale)}</td>
                <td className="pr-3">{r.agentId ? `@${accounts[r.agentId]?.handle ?? r.agentId.slice(0, 8)}` : '—'}</td>
                <td className="pr-3">{r.channelId ? `#${channels.find((c) => c.id === r.channelId)?.name ?? r.channelId.slice(0, 8)}` : '—'}</td>
                <td>{accessText(t, r)}{r.version !== null ? ` · v${r.version}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-1 text-meta text-fg-subtle">{t('secrets.accessNote')}</p>
    </div>
  );
}
