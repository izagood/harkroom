import { useCallback, useEffect, useState } from 'react';
import { API_METHODS, type ApiAuthKind, type ApiConnectorView, type ApiMethod } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { ApiError, type SecretView } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { ConfirmDialog } from '../ConfirmDialog';
import { Button, Field, Segmented, TextInput } from './primitives';
import { errorText } from '../../lib/errorText';

/**
 * 설정 › 나 › 비밀과 API — **API 연결** 절(외부 API 권한 C안 P4b, designer v3 ②).
 *
 * 연결은 "어디로(https origin)·어떻게(Bearer/헤더)·무슨 키(내 비밀)·최대 어떤 메서드"다. 에이전트는 연결 이름과 경로만 쓰고,
 * 주소·키는 여기서 정한 대로 오퍼레이터가 붙인다. 판정은 전부 서버(`connectorRoutes.ts`)이고 화면은 서버의 거절을 사람 말로 옮긴다.
 *
 * **주소·인증·키를 바꾸면 그 연결로 준 권한이 멈춘다**(서버가 정지한다). 바꾸기 전에 확인창이 몇 개가 멈추는지 말한다 —
 * 주소가 바뀌면 키가 다른 곳으로 가기 때문이다. 키의 **값**만 바꾸는 것은 비밀 절의 [값 바꾸기]이고 권한을 멈추지 않는다.
 */

type AuthKind = ApiAuthKind;
/**
 * 토큰 교환(156) 칸은 꼴을 바꿔도 지우지 않는다 — Bearer 로 잠깐 바꿨다 돌아와도 입력이 남는다(designer 대조 항목). 보낼 때만
 * `token_exchange` 일 때 싣는다.
 */
interface Draft {
  name: string; baseUrl: string; authKind: AuthKind; authHeader: string; secretId: string; methods: ApiMethod[];
  tokenUrl: string; grantType: string; clientId: string; keyField: string;
}
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// 서버 규칙과 같다(connectorRoutes.ts) — 여기는 [만들기]를 끄고 바로 경고하는 편의다.
const FORM_VALUE_RE = /^[\x20-\x7e]{1,200}$/;
const FORM_FIELD_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const RESERVED_FIELDS = new Set(['grant_type', 'client_id']);
const TOKEN_DEFAULTS = { tokenUrl: 'https://', grantType: 'client_credentials', clientId: '', keyField: 'client_secret' };
const emptyDraft = (): Draft => ({ name: '', baseUrl: 'https://', authKind: 'bearer', authHeader: '', secretId: '', methods: ['GET'], ...TOKEN_DEFAULTS });
const fromConnector = (c: ApiConnectorView): Draft => ({
  name: c.name, baseUrl: c.baseUrl, authKind: c.authKind, authHeader: c.authHeader ?? '', secretId: c.secretId ?? '', methods: [...c.methods],
  tokenUrl: c.tokenUrl ?? TOKEN_DEFAULTS.tokenUrl, grantType: c.tokenForm?.grantType ?? TOKEN_DEFAULTS.grantType,
  clientId: c.tokenForm?.clientId ?? TOKEN_DEFAULTS.clientId, keyField: c.tokenForm?.keyField ?? TOKEN_DEFAULTS.keyField,
});
/**
 * 토큰 주소 — https, 질의·조각·사용자 정보·인코딩된 점/슬래시 없음(경로는 된다). 맞으면 키가 갈 origin, 아니면 null.
 * 서버도 같은 규칙으로 다시 잰다(`normalizeTokenUrl`).
 */
export const tokenUrlOrigin = (u: string): string | null => {
  const s = u.trim();
  if (/%2e|%2f|%5c|%25/i.test(s) || /\/\.\.?(\/|$)/.test(s)) return null;
  try {
    const x = new URL(s);
    if (x.protocol !== 'https:' || x.search || x.hash || x.username || x.password || !x.hostname || s.includes('?') || s.includes('#')) return null;
    return x.origin;
  } catch { return null; }
};
const hostOf = (origin: string): string => origin.replace(/^https:\/\//, '');
/** https origin 만 — 경로·질의 없음. 서버도 같은 규칙으로 다시 잰다(여기는 [만들기]를 끄는 편의). */
const looksHttpsOrigin = (u: string): boolean => {
  try { const x = new URL(u); return x.protocol === 'https:' && (x.pathname === '/' || x.pathname === '') && !x.search && !x.hash && !x.username; } catch { return false; }
};

export function ConnectorsSection({ secrets, enabled, onChanged }: {
  /** 키로 고를 수 있는 것 — 내 텍스트 비밀만(서버 규칙과 같다). */
  secrets: SecretView[];
  enabled: boolean;
  onChanged(): Promise<void>;
}) {
  const t = useT();
  const me = useActiveStore((s) => s.me);
  const [rows, setRows] = useState<ApiConnectorView[] | 'loading' | 'error'>('loading');
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [confirming, setConfirming] = useState<{ id: string; draft: Draft; grants: number } | null>(null);
  const [deleting, setDeleting] = useState<ApiConnectorView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRows(await getController().listConnectors()); } catch { setRows('error'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const explain = (err: unknown): string => {
    if (err instanceof ApiError) {
      switch (err.code) {
        case 'name_taken': return t('connectors.errNameTaken');
        case 'bad_base_url': return t('connectors.errBaseUrl');
        case 'bad_header': return t('connectors.errHeader');
        case 'no_secret': return t('connectors.errSecret');
        case 'bad_secret': return t('connectors.errSecretKind');
        case 'bad_token_url': return t('connectors.tokenUrlBad');
        case 'bad_token_form': return t('connectors.errTokenForm');
        default: break;
      }
      if (err.status === 403) return t('connectors.errForbidden');
    }
    return t('connectors.errFailed', { reason: errorText(err, t) });
  };
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); await load(); await onChanged(); return true; } catch (e) { setError(explain(e)); return false; } finally { setBusy(false); }
  };

  const keyOptions = secrets.filter((s) => s.kind === 'text' && s.ownerAccountId === me?.id);
  const secretName = (id: string | null) => (id ? secrets.find((s) => s.id === id)?.name ?? null : null);

  const body = (d: Draft) => ({
    baseUrl: d.baseUrl.trim(), authKind: d.authKind,
    authHeader: d.authKind === 'header' ? d.authHeader.trim() : null,
    secretId: d.authKind === 'none' ? null : d.secretId || null,
    methods: d.methods,
    ...(d.authKind === 'token_exchange'
      ? { tokenUrl: d.tokenUrl.trim(), tokenForm: { grantType: d.grantType.trim(), clientId: d.clientId.trim(), keyField: d.keyField.trim() } }
      // 다른 꼴로 바꾸면 서버가 토큰 칸을 비운다 — 여기서는 싣지 않는다.
      : {}),
  });
  const save = async (id: string | null, d: Draft) => {
    if (id === null) {
      if (await run(async () => { await getController().createConnector({ name: d.name, ...body(d) }); })) setEditing(null);
      return;
    }
    if (await run(async () => {
      const r = await getController().patchConnector(id, body(d));
      if (r.suspendedGrants > 0) setNotice(t('connectors.suspendedNotice', { n: String(r.suspendedGrants) }));
    })) setEditing(null);
  };
  /** 주소·인증·키·토큰 주소·보내는 값이 바뀌면 그 연결의 권한이 멈춘다(서버와 같은 판정) — 권한이 있는 연결이면 확인창을 먼저 띄운다. */
  const submit = (id: string | null, d: Draft) => {
    const cur = id && Array.isArray(rows) ? rows.find((c) => c.id === id) : undefined;
    if (cur && cur.grantCount > 0) {
      const b = body(d);
      const target = b.baseUrl !== cur.baseUrl || b.authKind !== cur.authKind || (b.authHeader ?? null) !== cur.authHeader || (b.secretId ?? null) !== cur.secretId
        || ('tokenUrl' in b && (b.tokenUrl !== cur.tokenUrl || JSON.stringify(b.tokenForm) !== JSON.stringify(cur.tokenForm)));
      if (target) { setConfirming({ id: cur.id, draft: d, grants: cur.grantCount }); return; }
    }
    void save(id, d);
  };

  const list = Array.isArray(rows) ? rows : [];
  return (
    // 비밀 절과 같은 꼴: 테두리 없는 제목줄 + 목록 하나만 테두리(designer 시안 v1 #7·#10). 주 버튼은 비밀 쪽 하나라 여기는 보조.
    <section className="mt-8" data-testid="connectors">
      <div className="mb-2 flex items-center gap-2.5">
        <h3 className="text-meta font-semibold text-fg">{t('connectors.heading')}</h3>
        {Array.isArray(rows) && <span className="text-meta text-fg-subtle">{list.length}</span>}
        {enabled && !editing && (
          <span className="ml-auto"><Button onClick={() => { setEditing({ id: null, draft: emptyDraft() }); setError(null); }} disabled={busy}>{t('connectors.add')}</Button></span>
        )}
      </div>
      {rows === 'loading' && <p className="mt-2 text-meta text-fg-muted">{t('secrets.loading')}</p>}
      {rows === 'error' && <p role="alert" className="mt-2 text-meta text-danger">{t('connectors.listFailed')}</p>}
      {/* 빈 상태 한 문단이 무엇이 좋은지 말한다 — 설명 줄과 「아직 없다」 두 줄을 하나로. 목록이 있으면 설명은 한 줄로 남긴다. */}
      {Array.isArray(rows) && list.length === 0 && !editing && (
        <p className="rounded-card border border-border px-3.5 py-3 text-meta text-fg-muted" data-testid="connectors-none">{t('connectors.none')}</p>
      )}
      {Array.isArray(rows) && list.length > 0 && <p className="mb-2 text-meta text-fg-subtle">{t('connectors.note')}</p>}

      {editing?.id === null && (
        <ConnectorForm draft={editing.draft} creating busy={busy} keyOptions={keyOptions}
          onChange={(draft) => setEditing({ id: null, draft })} onCancel={() => setEditing(null)} onSubmit={(d) => submit(null, d)} />
      )}

      <ul className={list.length > 0 ? 'divide-y divide-border rounded-card border border-border' : ''}>
        {list.map((c) => {
          const mine = c.ownerAccountId === me?.id;
          const keyName = secretName(c.secretId);
          const noKey = c.authKind !== 'none' && !c.secretId;
          return (
            <li key={c.id} className="px-3 py-2 text-meta" data-testid={`connector-${c.name}`}>
              <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${noKey ? 'text-fg-subtle' : 'text-fg'}`}>
                <span className="font-mono font-medium">{c.name}</span>
                <span className="font-mono text-fg-subtle">{c.baseUrl}</span>
                {c.authKind !== 'none' && keyName && (
                  <span className="text-fg-subtle">{c.authKind === 'token_exchange'
                    ? t('connectors.keyToken', { name: keyName, host: hostOf(tokenUrlOrigin(c.tokenUrl ?? '') ?? '') })
                    : t(c.authKind === 'bearer' ? 'connectors.keyBearer' : 'connectors.keyHeader', { name: keyName, header: c.authHeader ?? '' })}</span>
                )}
                {noKey && <span className="rounded bg-danger-surface px-1 text-danger">{t('connectors.noKey')}</span>}
                {c.methods.map((m) => <span key={m} className="rounded border border-border px-1 text-fg-muted">{m}</span>)}
                <span className="text-fg-subtle">{t('connectors.grantCount', { n: String(c.grantCount) })}</span>
                <span className="ml-auto flex gap-1">
                  {mine && enabled && (
                    <button type="button" className="rounded border border-border px-2 py-0.5 text-meta text-fg hover:bg-surface-sunken disabled:opacity-50"
                      disabled={busy} onClick={() => { setEditing({ id: c.id, draft: fromConnector(c) }); setError(null); }}>{t('connectors.edit')}</button>
                  )}
                  <button type="button" className="rounded border border-border px-2 py-0.5 text-meta text-fg hover:text-danger disabled:opacity-50"
                    disabled={busy} aria-label={t('connectors.deleteAria', { name: c.name })} onClick={() => setDeleting(c)}>{t('connectors.delete')}</button>
                </span>
              </div>
              {editing?.id === c.id && (
                <ConnectorForm draft={editing.draft} busy={busy} keyOptions={keyOptions}
                  onChange={(draft) => setEditing({ id: c.id, draft })} onCancel={() => setEditing(null)} onSubmit={(d) => submit(c.id, d)} />
              )}
            </li>
          );
        })}
      </ul>
      {notice && <p className="mt-2 text-meta text-warning" data-testid="connectors-notice">{notice}</p>}
      {error && <p role="alert" className="mt-2 text-meta text-danger" data-testid="connectors-error">{error}</p>}

      {confirming && (
        <ConfirmDialog
          title={t('connectors.changeTitle')}
          detail={t('connectors.changeDetail', { n: String(confirming.grants) })}
          detailKind="note"
          confirmLabel={t('connectors.changeConfirm')}
          cancelLabel={t('secrets.cancel')}
          danger busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => { const c = confirming; setConfirming(null); void save(c.id, c.draft); }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t('connectors.deleteTitle', { name: deleting.name })}
          detail={deleting.grantCount > 0 ? t('connectors.deleteDetailUsed', { n: String(deleting.grantCount) }) : t('connectors.deleteDetail')}
          detailKind="note"
          confirmLabel={t('connectors.delete')}
          cancelLabel={t('secrets.cancel')}
          danger busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={() => { const c = deleting; setDeleting(null); void run(() => getController().deleteConnector(c.id)); }}
        />
      )}
    </section>
  );
}

function ConnectorForm({ draft, creating = false, busy, keyOptions, onChange, onCancel, onSubmit }: {
  draft: Draft; creating?: boolean; busy: boolean; keyOptions: SecretView[];
  onChange(d: Draft): void; onCancel(): void; onSubmit(d: Draft): void;
}) {
  const t = useT();
  const set = (p: Partial<Draft>) => onChange({ ...draft, ...p });
  const nameOk = !creating || NAME_RE.test(draft.name);
  const urlOk = looksHttpsOrigin(draft.baseUrl.trim());
  const headerOk = draft.authKind !== 'header' || /^[A-Za-z0-9-]{1,64}$/.test(draft.authHeader.trim());
  const keyOk = draft.authKind === 'none' || draft.secretId !== '';
  const tx = draft.authKind === 'token_exchange';
  const tokenOrigin = tokenUrlOrigin(draft.tokenUrl);
  const grantOk = FORM_VALUE_RE.test(draft.grantType.trim());
  const clientOk = FORM_VALUE_RE.test(draft.clientId.trim());
  const fieldOk = FORM_FIELD_RE.test(draft.keyField.trim()) && !RESERVED_FIELDS.has(draft.keyField.trim().toLowerCase());
  const tokenOk = !tx || (tokenOrigin !== null && grantOk && clientOk && fieldOk);
  const ready = nameOk && urlOk && headerOk && keyOk && tokenOk && draft.methods.length > 0;
  const baseOrigin = urlOk ? new URL(draft.baseUrl.trim()).origin : null;
  // 보내는 값 미리보기 — 실제와 같은 인코딩(URLSearchParams), 키 자리는 가린다.
  const preview = (() => {
    const p = new URLSearchParams();
    p.set('grant_type', draft.grantType.trim()); p.set('client_id', draft.clientId.trim());
    return `${p.toString()}&${encodeURIComponent(draft.keyField.trim())}=••••`;
  })();
  // 미리보기 머리 — HTTP 메서드와 호스트·경로(번역할 글자가 아니다).
  const previewHead = tokenOrigin ? `${'POST'} ${hostOf(tokenOrigin)}${new URL(draft.tokenUrl.trim()).pathname.replace(/^\/$/, '')}` : null;
  const keySelect = (
    <label className="block text-meta text-fg">
      {t('connectors.key')}
      <select aria-label={t('connectors.key')} className="mt-1 block w-full rounded border border-border bg-field px-2 py-1 text-meta text-fg"
        value={draft.secretId} disabled={busy} onChange={(e) => set({ secretId: e.target.value })}>
        <option value="">{t('connectors.keyPick')}</option>
        {keyOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <span className="mt-1 block text-fg-subtle">{t('connectors.keyHint')}</span>
    </label>
  );
  const monoInput = 'mt-1 block w-full rounded border bg-field px-2 py-1 font-mono text-meta text-fg';
  return (
    <div className="mt-2 space-y-3 rounded border border-border bg-surface-sunken p-3" data-testid="connector-form">
      {creating && (
        <Field label={t('connectors.name')} hint={t('connectors.nameHint')} tone={draft.name && !nameOk ? 'warning' : 'muted'}>
          <TextInput value={draft.name} onChange={(v) => set({ name: v.trim() })} placeholder="lab-api" disabled={busy} />
        </Field>
      )}
      <Field label={t('connectors.baseUrl')} hint={t('connectors.baseUrlHint')} tone={draft.baseUrl !== 'https://' && !urlOk ? 'warning' : 'muted'}>
        <TextInput value={draft.baseUrl} onChange={(v) => set({ baseUrl: v })} placeholder="https://api.example.internal" disabled={busy} />
      </Field>
      <div>
        <span className="text-meta text-fg">{t('connectors.auth')}</span>
        <Segmented wrap label={t('connectors.auth')} value={draft.authKind} onChange={(v) => set({ authKind: v as AuthKind })} options={[
          { value: 'bearer', label: t('connectors.authBearer') }, { value: 'header', label: t('connectors.authHeader') },
          { value: 'token_exchange', label: t('connectors.authToken') }, { value: 'none', label: t('connectors.authNone') },
        ]} />
        {tx && <span className="mt-1 block text-meta text-fg-subtle">{t('connectors.authTokenHint')}</span>}
      </div>
      {draft.authKind === 'header' && (
        <Field label={t('connectors.headerName')} hint={t('connectors.headerHint')}>
          <TextInput value={draft.authHeader} onChange={(v) => set({ authHeader: v })} placeholder="X-Api-Key" disabled={busy} />
        </Field>
      )}
      {(draft.authKind === 'bearer' || draft.authKind === 'header') && keySelect}
      {tx && (
        // 토큰 교환 묶음 — 키가 form 의 한 칸이라는 관계가 보이게 키 고르기도 이 안에 둔다(designer 시안 v1 #5).
        <div className="space-y-2.5 border-l-2 border-border pl-2.5" data-testid="connector-token">
          <label className="block text-meta text-fg">
            {t('connectors.tokenUrl')}
            <input aria-label={t('connectors.tokenUrl')} className={`${monoInput} ${draft.tokenUrl !== 'https://' && !tokenOrigin ? 'border-warning' : 'border-border'}`}
              value={draft.tokenUrl} disabled={busy} placeholder="https://auth.example.com/oauth/token" onChange={(e) => set({ tokenUrl: e.target.value })} />
            {draft.tokenUrl !== 'https://' && !tokenOrigin && <span className="mt-1 block text-warning">{t('connectors.tokenUrlBad')}</span>}
            {tokenOrigin && (tokenOrigin !== baseOrigin
              // 키가 기본 주소와 다른 호스트로 간다 — 눈에 띄게(security S1, designer #2).
              ? <span className="mt-1.5 block rounded-row bg-warning-surface px-2 py-1 text-warning" data-testid="connector-token-dest">
                  ⚠ {t('connectors.tokenDest', { origin: tokenOrigin })} {t('connectors.tokenDestOther')}
                </span>
              : <span className="mt-1 block text-fg-muted" data-testid="connector-token-dest">
                  🔑 {t('connectors.tokenDest', { origin: tokenOrigin })} {t('connectors.tokenDestSame')}
                </span>)}
          </label>
          <div className="flex flex-wrap gap-2">
            <label className="block min-w-[9rem] flex-1 text-meta text-fg">
              grant_type
              <input aria-label="grant_type" list="connector-grant-types" className={`${monoInput} ${grantOk ? 'border-border' : 'border-warning'}`}
                value={draft.grantType} disabled={busy} onChange={(e) => set({ grantType: e.target.value })} />
              <datalist id="connector-grant-types"><option value="client_credentials" /><option value="password" /></datalist>
            </label>
            <label className="block min-w-[9rem] flex-1 text-meta text-fg">
              client_id
              <input aria-label="client_id" className={`${monoInput} ${draft.clientId === '' || clientOk ? 'border-border' : 'border-warning'}`}
                value={draft.clientId} disabled={busy} onChange={(e) => set({ clientId: e.target.value })} />
            </label>
            <label className="block min-w-[9rem] flex-1 text-meta text-fg">
              {t('connectors.keyField')}
              <input aria-label={t('connectors.keyField')} className={`${monoInput} ${fieldOk ? 'border-border' : 'border-warning'}`}
                value={draft.keyField} disabled={busy} onChange={(e) => set({ keyField: e.target.value })} />
            </label>
          </div>
          {!fieldOk && <span className="block text-meta text-warning">{t('connectors.keyFieldBad')}</span>}
          {((!grantOk) || (draft.clientId !== '' && !clientOk)) && <span className="block text-meta text-warning">{t('connectors.formValueBad')}</span>}
          {keySelect}
          <div>
            <span className="text-meta text-fg">{t('connectors.formPreview')}</span>
            <div className="mt-1 break-all rounded border border-dashed border-border bg-field px-2 py-1 font-mono text-meta text-fg-muted" data-testid="connector-token-preview">
              {previewHead && <>{previewHead}<br /></>}
              {preview}
            </div>
          </div>
        </div>
      )}
      <fieldset>
        <legend className="text-meta text-fg">{t('connectors.methods')}</legend>
        <div className="mt-1 flex flex-wrap gap-3">
          {API_METHODS.map((m) => (
            <label key={m} className="flex items-center gap-1 text-meta text-fg">
              <input type="checkbox" checked={draft.methods.includes(m)} disabled={busy}
                onChange={(e) => set({ methods: e.target.checked ? [...draft.methods, m] : draft.methods.filter((x) => x !== m) })} />
              {m}
            </label>
          ))}
        </div>
        <span className="mt-1 block text-meta text-fg-subtle">{t('connectors.methodsHint')}</span>
      </fieldset>
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => onSubmit(draft)} disabled={busy || !ready}>{creating ? t('connectors.create') : t('connectors.save')}</Button>
        <Button onClick={onCancel} disabled={busy}>{t('secrets.cancel')}</Button>
      </div>
    </div>
  );
}
