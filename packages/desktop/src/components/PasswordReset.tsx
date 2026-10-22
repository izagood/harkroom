import { useEffect, useRef, useState } from 'react';
import { compareRelease, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type AccountView } from '@harkroom/shared';
import { getController } from '../state/controller';
import { useActiveStore } from '../state/communities';
import { ApiClient, ApiError, type PasswordResetNotice } from '../lib/api';
import { useLocale, useT } from '../i18n/useT';
import { writeConcealed } from '../lib/concealedClipboard';
import { copyText } from '../lib/clipboard';
import { hasCapability } from '../lib/capabilities';
import { retryAfterSec } from './settings/SecretReveal';
import { Button } from './settings/primitives';
import { Overlay } from './Overlay';

/**
 * 비밀번호 재설정 코드 — 화면 쪽(스레드 a6017542, jaebin B안, designer 시안 R1~R8). 서버는 #1409.
 *
 * - 관리자: 설정 › 멤버와 초대의 사람 줄 끝 [재설정 코드] → 비밀번호 재확인(step-up) → 코드를 **한 번만** 보인다.
 *   코드는 이 창의 상태에만 있고 닫으면 사라진다. 복사는 가림 클립보드(60초 뒤 비움)를 먼저 쓴다.
 * - 잊은 사람: 로그인 화면 「비밀번호를 잊었다면」 → 안내(서버 호출 없음, R2) → 로그인 ID·코드·새 비밀번호(R3·R5).
 * - 본인 알림(R7): 로그인 뒤 띠 하나. 발급자는 id 로 오고 이름은 계정 목록에서 푼다(모르면 「관리자」).
 *
 * 서버 하한(MIN_SERVER_VERSION)은 올리지 않는다 — 모든 자리가 서버 판(`/healthz`)이나 서버 값(capability)으로
 * 열린다(`serverSurfaceGated.json`). 옛 서버 앞에서는 버튼이 없거나 「이 서버는 아직 지원하지 않는다」를 말한다.
 */

/** 재설정 코드가 들어간 서버 릴리스(#1409). */
export const PASSWORD_RESET_SINCE = '0.4.122';

export function resetSupported(version: string | null | undefined): boolean {
  return !!version && (compareRelease(version, PASSWORD_RESET_SINCE) ?? -1) >= 0;
}

/** 서버 `targetFor` 와 같은 선 — 자기 자신·owner 는 아니고, admin 대상은 owner 만. 판정의 정본은 서버다. */
export function canIssueResetCode(me: (AccountView & { capabilities?: unknown }) | null, target: AccountView): boolean {
  if (!me || target.kind !== 'human' || target.id === me.id || target.disabled) return false;
  if (!hasCapability(me, 'member.reset_password')) return false;
  if (target.role === 'owner') return false;
  if (target.role === 'admin' && me.role !== 'owner') return false;
  return true;
}

/** 사람이 친 코드를 4-4-4 로 묶어 보인다(입력 칸 표시용). 서버는 하이픈·대소문자를 무시한다. */
export function groupCode(raw: string): string {
  const s = raw.replace(/[\s-]/g, '').toUpperCase().slice(0, 12);
  return s.replace(/(.{4})(?=.)/g, '$1-');
}

// ---- 관리자: 코드 발급 창 ------------------------------------------------------------------------

export function ResetCodeButton({ account }: { account: AccountView }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="rounded-row border border-border px-2 py-0.5 text-meta hover:bg-surface-hover"
        data-testid={`reset-code-open-${account.id}`} onClick={() => setOpen(true)}
        aria-label={t('pwreset.issue.openLabel', { name: account.displayName || account.handle })}>
        {t('pwreset.issue.open')}
      </button>
      {open && <ResetCodeDialog account={account} onClose={() => setOpen(false)} />}
    </>
  );
}

type Issued = { code: string; expiresAt: string; loginId?: string };

export function ResetCodeDialog({ account, onClose }: { account: AccountView; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const [step, setStep] = useState<'confirm' | 'code' | 'revoked'>('confirm');
  const [password, setPassword] = useState('');
  const [issued, setIssued] = useState<Issued | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLElement | null>(null);
  const name = account.displayName || account.handle;

  // 코드는 이 창이 닫히면 함께 사라진다 — 상태 밖(스토어·저장소)에 두지 않는다.
  useEffect(() => () => { setIssued(null); }, []);

  /** 이 창이 step-up 창을 직접 열었는가 — 그때만 닫을 때 잠근다(security #1410 n1). 이미 열려 있던 창은 건드리지 않는다. */
  const openedStepUp = useRef(false);
  useEffect(() => () => { if (openedStepUp.current) void getController().lockSecrets().catch(() => {}); }, []);

  const issue = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      let r: Issued;
      try {
        // 먼저 그냥 발급해 본다 — 창이 이미 열려 있으면 비밀번호 없이 된다.
        r = await getController().issuePasswordResetCode(account.id);
      } catch (e) {
        const needs = e instanceof ApiError && e.code === 'step_up_required';
        if (!needs || !password) throw e;
        await getController().unlockSecrets(password);
        openedStepUp.current = true;
        setPassword('');
        r = await getController().issuePasswordResetCode(account.id);
      }
      setIssued(r); setStep('code');
    } catch (e) {
      const wait = retryAfterSec(e);
      if (wait !== null) setError(t('pwreset.issue.limited', { minutes: String(Math.max(1, Math.ceil(wait / 60))) }));
      else if (e instanceof ApiError && e.status === 401) setError(t('pwreset.issue.wrongPassword'));
      else if (e instanceof ApiError && e.code === 'step_up_required') setError(t('pwreset.issue.needPassword'));
      else setError(e instanceof ApiError ? e.message : t('pwreset.issue.failed'));
    } finally { setBusy(false); }
  };

  const revoke = async () => {
    setBusy(true); setError(null);
    try {
      await getController().revokePasswordResetCode(account.id);
      setIssued(null); setStep('revoked');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('pwreset.issue.failed'));
    } finally { setBusy(false); }
  };

  const copy = async () => {
    if (!issued) return;
    if (await writeConcealed(issued.code)) { setNote(t('pwreset.issue.copiedConcealed')); return; }
    const outcome = await copyText(issued.code, codeRef.current);
    setNote(outcome === 'copied' ? t('pwreset.issue.copied') : outcome === 'selected' ? t('pwreset.issue.selected') : t('pwreset.issue.copyFailed'));
  };

  const until = issued ? new Date(issued.expiresAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <Overlay label={t('pwreset.issue.title', { name })} onClose={busy || step === 'code' ? () => {} : onClose} align="center" className="w-[min(440px,calc(100vw-32px))]">
      <div className="p-4" data-testid="reset-code-dialog">
        <h2 className="text-body font-medium">{t('pwreset.issue.title', { name })}</h2>
        {step === 'confirm' && (
          <form onSubmit={(e) => { e.preventDefault(); void issue(); }} className="mt-2">
            <p className="text-meta text-fg-muted">{t('pwreset.issue.body', { name })}</p>
            <input type="password" autoComplete="current-password" value={password} autoFocus
              onChange={(e) => setPassword(e.target.value)} aria-label={t('pwreset.issue.password')}
              placeholder={t('pwreset.issue.password')} data-testid="reset-code-password"
              className="mt-3 w-full rounded border border-border bg-surface px-2 py-1 text-body" />
            <p className="mt-1 text-meta text-fg-subtle">{t('pwreset.issue.passwordHint')}</p>
            {error && <p role="alert" className="mt-2 text-meta text-danger" data-testid="reset-code-error">{error}</p>}
            <div className="mt-3 flex justify-end gap-2">
              <Button onClick={onClose}>{t('pwreset.cancel')}</Button>
              <button type="submit" disabled={busy} data-testid="reset-code-issue"
                className="rounded-row bg-accent px-3 py-1 font-medium text-fg-on-strong hover:bg-accent-hover disabled:opacity-50">
                {t('pwreset.issue.submit')}
              </button>
            </div>
          </form>
        )}
        {step === 'code' && issued && (
          <div className="mt-2">
            <div className="flex items-center gap-2">
              <code ref={codeRef} data-testid="reset-code-value"
                className="flex-1 rounded-row border border-border bg-surface px-3 py-2 text-center font-mono text-name font-semibold tracking-wider">
                {issued.code}
              </code>
              <button type="button" onClick={() => void copy()} data-testid="reset-code-copy"
                className="rounded-row bg-accent px-3 py-2 font-medium text-fg-on-strong hover:bg-accent-hover">{t('pwreset.issue.copy')}</button>
            </div>
            {/* 재설정은 handle 이 아니라 **로그인 ID** 로 찾는다 — 둘이 다른 사람이 있다(10-22 jinbin). 코드와 같이 보이고 같이 전하게 한다. */}
            {issued.loginId && (
              <p className="mt-2 text-body" data-testid="reset-code-login-id">
                {t('pwreset.issue.loginIdLabel')} <code className="font-mono font-semibold">{issued.loginId}</code>
              </p>
            )}
            <p className="mt-2 text-meta text-fg-muted">{t('pwreset.issue.meta', { time: until })}</p>
            {note && <p className="mt-1 text-meta text-fg-muted" aria-live="polite">{note}</p>}
            <div className="mt-3 rounded-row border border-warning-border bg-warning-surface p-2 text-meta text-warning">{t(issued.loginId ? 'pwreset.issue.onlyNowWithLogin' : 'pwreset.issue.onlyNow', { name })}</div>
            <div className="mt-2 rounded-row border border-border p-2 text-meta text-fg-muted">{t('pwreset.issue.effect', { name })}</div>
            {error && <p role="alert" className="mt-2 text-meta text-danger">{error}</p>}
            <div className="mt-3 flex justify-end gap-2">
              <Button onClick={() => void revoke()}>{t('pwreset.issue.revoke')}</Button>
              <button type="button" onClick={onClose} data-testid="reset-code-close"
                className="rounded-row bg-accent px-3 py-1 font-medium text-fg-on-strong hover:bg-accent-hover">{t('pwreset.close')}</button>
            </div>
          </div>
        )}
        {step === 'revoked' && (
          <div className="mt-2">
            <p className="text-meta text-fg-muted" data-testid="reset-code-revoked">{t('pwreset.issue.revoked', { name })}</p>
            <div className="mt-3 flex justify-end"><Button onClick={onClose}>{t('pwreset.close')}</Button></div>
          </div>
        )}
      </div>
    </Overlay>
  );
}

// ---- 잊은 사람: 로그인 화면의 두 단계 -------------------------------------------------------------

const field = 'w-full rounded-row border border-border bg-field px-3 py-2 text-fg placeholder-fg-subtle';

/** ② 안내 — 서버를 부르지 않는다(R2). 관리자 이름도 보이지 않는다. */
export function ForgotPasswordGuide({ onHaveCode, onBack }: { onHaveCode: () => void; onBack: () => void }) {
  const t = useT();
  return (
    <div className="space-y-3" data-testid="pwreset-guide">
      <h2 className="text-body font-semibold">{t('pwreset.guide.title')}</h2>
      <p className="text-meta">{t('pwreset.guide.body')}</p>
      <ol className="list-decimal space-y-1 pl-5 text-meta">
        <li>{t('pwreset.guide.step1')}</li>
        <li>{t('pwreset.guide.step2')}</li>
      </ol>
      <p className="rounded-row border border-border bg-surface p-2 text-meta text-fg-muted">{t('pwreset.guide.note')}</p>
      <button type="button" onClick={onHaveCode} data-testid="pwreset-have-code"
        className="w-full rounded-row bg-accent py-2 font-medium text-fg-on-strong">{t('pwreset.guide.haveCode')}</button>
      <details className="text-meta text-fg-muted">
        <summary className="cursor-pointer">{t('pwreset.guide.noAdminSummary')}</summary>
        <p className="mt-1">{t('pwreset.guide.noAdminBody')}</p>
      </details>
      <button type="button" className="w-full text-meta text-fg-subtle underline" onClick={onBack}>{t('connect.alt.back')}</button>
    </div>
  );
}

/**
 * ③ 로그인 ID·코드·새 비밀번호 — 한 화면에서 끝낸다. 성공하면 곧바로 로그인(`onSignedIn`). 다른 기기가 끊겼다는
 * 말은 로그인 뒤 알림 띠가 한다(그 코드가 「사용됨」으로 실려 온다).
 */
export function ResetWithCodeForm({ baseUrl, initialLoginId, onSignedIn, onBack }: {
  baseUrl: string; initialLoginId: string;
  onSignedIn: (api: ApiClient, token: string) => Promise<void>;
  onBack: () => void;
}) {
  const t = useT();
  const [loginId, setLoginId] = useState(initialLoginId);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = pw2 !== '' && pw !== pw2;
  // 「8자 이상」은 칸을 떠난 뒤나 제출을 시도한 뒤에만 말한다(designer n5) — 첫 글자부터 빨갛게 서면 꾸지람처럼 읽힌다.
  const [pwTouched, setPwTouched] = useState(false);
  const [tried, setTried] = useState(false);
  const short = (pwTouched || tried) && pw !== '' && pw.length < PASSWORD_MIN_LENGTH;
  // 서버 규칙(shared passwordRule)을 넘기면 서버의 400 이 「코드가 틀렸다」로 읽히므로 화면에서 막는다(security #1410 n2).
  // 칸에 maxLength 는 걸지 않는다 — 붙여 넣은 값이 말없이 잘리면 사람은 자기가 정한 것과 다른 비밀번호를 갖게 된다.
  const long = pw.length > PASSWORD_MAX_LENGTH;
  const blocked = busy || !loginId.trim() || code.replace(/-/g, '').length !== 12 || pw.length < PASSWORD_MIN_LENGTH || long || pw !== pw2;

  const submit = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const api = new ApiClient(baseUrl);
      // 옛 서버에는 이 라우트가 없다 — 404 를 「코드가 틀렸다」로 읽히게 두지 않는다.
      const v = await api.serverVersion().catch(() => null);
      if (v && v.version && !resetSupported(v.version)) { setError(t('pwreset.form.unsupported')); return; }
      const { token } = await api.resetPasswordWithCode(loginId.trim(), code, pw);
      setPw(''); setPw2(''); setCode('');
      await onSignedIn(api, token);
    } catch (e) {
      const wait = retryAfterSec(e);
      // 실패 문구는 하나다(R1) — 서버가 가르지 않는 것을 화면이 가르지 않는다.
      if (wait !== null) setError(t('pwreset.form.limited', { minutes: String(Math.max(1, Math.ceil(wait / 60))) }));
      else if (e instanceof ApiError && e.status === 400) setError(t('pwreset.form.invalid'));
      else setError(e instanceof ApiError ? e.message : t('connect.serverUnreachable'));
    } finally { setBusy(false); }
  };

  return (
    <form className="space-y-3" data-testid="pwreset-form" onSubmit={(e) => { e.preventDefault(); setTried(true); if (!blocked) void submit(); }}>
      <h2 className="text-body font-semibold">{t('pwreset.form.title')}</h2>
      <label className="block text-meta font-medium">
        {t('connect.field.loginId')}
        <input className={field} value={loginId} autoComplete="username" autoFocus={!initialLoginId} onChange={(e) => setLoginId(e.target.value)} data-testid="pwreset-login-id" />
      </label>
      <label className="block text-meta font-medium">
        {t('pwreset.form.code')}
        <input className={`${field} font-mono tracking-wider`} value={code} autoComplete="one-time-code" spellCheck={false} autoFocus={!!initialLoginId}
          autoCapitalize="characters" placeholder="K7QF-9MXD-2PQR" data-testid="pwreset-code"
          onChange={(e) => setCode(groupCode(e.target.value))} />
        <span className="mt-1 block font-normal text-fg-subtle">{t('pwreset.form.codeHint')}</span>
      </label>
      <label className="block text-meta font-medium">
        {t('pwreset.form.newPassword')}
        <input className={field} type="password" autoComplete="new-password" value={pw}
          onChange={(e) => setPw(e.target.value)} onBlur={() => setPwTouched(true)} data-testid="pwreset-new" />
        {short && <span className="mt-1 block font-normal text-danger">{t('pwreset.form.tooShort', { min: String(PASSWORD_MIN_LENGTH) })}</span>}
        {long && <span className="mt-1 block font-normal text-danger">{t('pwreset.form.tooLong', { max: String(PASSWORD_MAX_LENGTH) })}</span>}
      </label>
      <label className="block text-meta font-medium">
        {t('pwreset.form.confirm')}
        <input className={field} type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} data-testid="pwreset-confirm" />
        {mismatch && <span className="mt-1 block font-normal text-danger">{t('pwreset.form.mismatch')}</span>}
      </label>
      {error && <p role="alert" className="break-keep text-danger" data-testid="pwreset-error">{error}</p>}
      <button type="submit" data-testid="pwreset-submit" disabled={blocked}
        className="w-full rounded-row bg-accent py-2 font-medium text-fg-on-strong disabled:opacity-50">{t('pwreset.form.submit')}</button>
      <button type="button" className="w-full text-meta text-fg-subtle underline" onClick={onBack}>{t('pwreset.back')}</button>
    </form>
  );
}

// ---- 본인 알림(R7) --------------------------------------------------------------------------------

export function PasswordResetNoticeBanner() {
  const t = useT();
  const locale = useLocale();
  const version = useActiveStore((s) => s.serverVersion?.version ?? null);
  const accounts = useActiveStore((s) => s.accounts);
  const me = useActiveStore((s) => s.me);
  const [notices, setNotices] = useState<PasswordResetNotice[]>([]);

  useEffect(() => {
    if (!me || !resetSupported(version)) return;
    let alive = true;
    getController().passwordResetNotices().then(
      (r) => { if (alive) setNotices(r.notices); },
      () => { /* 알림을 못 읽은 것은 띠를 안 그릴 이유일 뿐이다 */ },
    );
    return () => { alive = false; };
  }, [me?.id, version]);

  if (notices.length === 0) return null;
  // 줄마다 하나씩 그린다(security #1410 F1) — 가장 최근 것 하나만 보이면 그 앞의 「부탁하지 않은 재설정」이 보지도 못한 채
  // [확인] 에 함께 내려간다. 서버가 최대 20개라 짧다. [확인] 은 **화면에 그린 id 만** 내린다.
  const nameOf = (id: string) => {
    const a = accounts[id];
    return a ? `${a.displayName || a.handle} (@${a.handle})` : t('pwreset.notice.unknownAdmin');
  };
  const anyUsed = notices.some((x) => x.usedAt);
  // 사용 안 된 발급이 섞여 있으면 「요청한 적 없다면 소유자에게」도 함께 말한다(designer #1410 n7).
  const anyUnused = notices.some((x) => !x.usedAt);
  const ack = () => {
    const ids = notices.map((x) => x.id);
    setNotices((cur) => cur.filter((x) => !ids.includes(x.id)));
    void getController().ackPasswordResetNotices(ids).catch(() => {});
  };
  return (
    <div role="status" data-testid="pwreset-notice"
      className="flex items-start gap-2 border-b border-warning-border bg-warning-surface px-4 py-2 text-body text-warning">
      <div className="flex-1">
        <ul className="space-y-0.5">
          {notices.map((n) => {
            const by = nameOf(n.issuedById);
            const when = new Date(n.issuedAt).toLocaleString(locale);
            return (
              <li key={n.id} data-testid={`pwreset-notice-${n.id}`} className="font-medium">
                {n.usedAt ? t('pwreset.notice.used', { by, when }) : t('pwreset.notice.issued', { by, when })}
                {!n.usedAt && n.revokedAt && <span className="ml-1 font-normal opacity-80">{t('pwreset.notice.revokedTag')}</span>}
              </li>
            );
          })}
        </ul>
        <p className="mt-0.5 opacity-80" data-testid="pwreset-notice-detail">
          {[anyUsed && t('pwreset.notice.usedDetail'), anyUnused && t('pwreset.notice.issuedDetail')].filter(Boolean).join(' ')}
        </p>
      </div>
      <button type="button" onClick={ack} data-testid="pwreset-notice-ack"
        className="shrink-0 rounded-row border border-warning-border px-2 py-0.5 text-meta hover:bg-surface">{t('pwreset.notice.ack')}</button>
    </div>
  );
}
