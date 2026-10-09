import { useEffect, useRef, useState } from 'react';
import { compareRelease } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { ApiError, type SecretView } from '../../lib/api';
import { useLocale, useT } from '../../i18n/useT';
import { writeConcealed } from '../../lib/concealedClipboard';
import { copyText } from '../../lib/clipboard';
import { Button } from './primitives';

/**
 * 비밀 보관소 **소유자 보기**(114, 스레드 464aff1c · designer 시안 v3). 서버 판정은 `secretRoutes.ts` 의
 * `POST /secrets/:id/reveal` 과 `/auth/step-up` — 이 파일은 그 위의 화면이다.
 *
 * 지키는 것:
 * - **잠금 해제는 보관소 단위**(jaebin): 비밀번호를 한 번 넣으면 모든 행을 더 묻지 않고 본다. 끝 시각은
 *   서버가 준 `steppedUpUntil` 로만 그린다 — 화면이 따로 세면 서버와 어긋난다.
 * - **값은 이 컴포넌트의 지역 상태에만** 둔다(store·로그·i18n 인자 밖). 30초 뒤, 잠기면, 창을 숨기면 지운다.
 * - **복사도 서버에서 다시 받는다**(`action: 'copy'`) — 화면에 떠 있는 값을 복사하면 「복사함」이 자기 신고가 된다.
 * - 잠그기·설정 닫기·앱 숨김은 `DELETE /auth/step-up` 을 부르되 **응답을 기다리지 않고** 화면부터 잠근다.
 */

/** 소유자 보기가 들어간 서버 릴리스(#1253). 이보다 낮으면 버튼을 숨긴다. */
export const SECRET_REVEAL_SINCE = '0.4.20';
const HIDE_AFTER_S = 30;

export function useRevealSupported(): boolean {
  const version = useActiveStore((s) => s.serverVersion?.version ?? null);
  return version !== null && (compareRelease(version, SECRET_REVEAL_SINCE) ?? -1) >= 0;
}

/** 기록에 남길 「어디서」 — 앱이 스스로 밝히는 판·OS 다(서버는 검증하지 않는다). */
export function clientLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const os = /Mac/i.test(ua) ? 'macOS' : /Win/i.test(ua) ? 'Windows' : /Linux/i.test(ua) ? 'Linux' : 'web';
  const v = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '?';
  return `Harkroom ${v} · ${os}`;
}

/** 429 의 남은 초 — 본문 `error.retryAfterSec`(F1). 없으면 null. */
export function retryAfterSec(e: unknown): number | null {
  if (!(e instanceof ApiError) || e.status !== 429) return null;
  const n = (e.payload as { error?: { retryAfterSec?: unknown } } | null)?.error?.retryAfterSec;
  return typeof n === 'number' && n > 0 ? n : null;
}

export type UnlockState = { until: number | null; autoLocked: boolean };

/** 머리줄: 잠김 → [잠금 해제…], 풀림 → 「잠금 해제됨 · HH:MM까지」[잠그기], 저절로 잠김 → 한 줄(aria-live 한 번). */
export function UnlockHeader({ unlock, onUnlock, onLock }: { unlock: UnlockState; onUnlock: () => void; onLock: () => void }) {
  const t = useT();
  const locale = useLocale();
  if (unlock.until !== null) {
    const hhmm = new Date(unlock.until).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    return (
      <span className="flex items-center gap-2" data-testid="secrets-unlocked">
        <span className="rounded bg-warning-surface px-2 py-0.5 text-meta text-warning">🔓 {t('secrets.unlockedUntil', { time: hhmm })}</span>
        <Button onClick={onLock}>{t('secrets.lock')}</Button>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <span aria-live="polite" className="text-meta text-fg-subtle" data-testid="secrets-autolocked">{unlock.autoLocked ? t('secrets.autoLocked') : ''}</span>
      <Button onClick={onUnlock}>🔒 {t('secrets.unlock')}</Button>
    </span>
  );
}

/** 비밀번호 확인 창 하나. 성공하면 `onDone(until)` — 누른 행이 있으면 부르는 쪽이 바로 연다. */
export function UnlockDialog({ thenName, onDone, onCancel }: {
  thenName: string | null; onDone: (until: string) => void; onCancel: () => void;
}) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<{ kind: 'wrong' } | { kind: 'limited'; minutes: number } | { kind: 'other' } | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const submit = async () => {
    if (!password || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await getController().unlockSecrets(password);
      setPassword('');
      onDone(r.steppedUpUntil);
    } catch (e) {
      const wait = retryAfterSec(e);
      if (wait !== null) setError({ kind: 'limited', minutes: Math.max(1, Math.ceil(wait / 60)) });
      else if (e instanceof ApiError && e.status === 401) { setError({ kind: 'wrong' }); input.current?.select(); }
      else setError({ kind: 'other' });
    } finally { setBusy(false); }
  };
  const limited = error?.kind === 'limited';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" data-testid="secrets-unlock-dialog">
      <div role="dialog" aria-modal="true" aria-labelledby="secrets-unlock-title"
        className="w-[min(420px,calc(100vw-32px))] rounded border border-border bg-surface-raised p-4 text-fg shadow-float">
        <h2 id="secrets-unlock-title" className="text-body font-medium">{t('secrets.unlockTitle')}</h2>
        <p className="mt-1 text-meta text-fg-muted">{t('secrets.unlockBody')}</p>
        {thenName && <p className="mt-1 text-meta text-fg-muted">{t('secrets.unlockThen', { name: thenName })}</p>}
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-3">
          <input ref={input} type="password" autoComplete="current-password" value={password} disabled={limited}
            onChange={(e) => setPassword(e.target.value)} aria-label={t('secrets.unlockPassword')} aria-invalid={error?.kind === 'wrong' || undefined}
            data-testid="secrets-unlock-password"
            className={`w-full rounded border bg-surface px-2 py-1 text-body ${error?.kind === 'wrong' ? 'border-danger' : 'border-border'}`} />
          {error && (
            <p role="alert" className="mt-1 text-meta text-danger" data-testid="secrets-unlock-error">
              {error.kind === 'wrong' ? t('secrets.unlockWrong') : error.kind === 'limited' ? t('secrets.unlockLimited', { n: String(error.minutes) }) : t('secrets.unlockFailed')}
            </p>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={onCancel}>{t('secrets.cancel')}</Button>
            <button type="submit" disabled={limited || busy || !password} data-testid="secrets-unlock-submit"
              className="rounded border border-border bg-surface px-2 py-1 text-meta text-fg disabled:opacity-50">{t('secrets.unlockSubmit')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * 행 아래 값 패널(text). 열리면 서버에서 받아 30초 보이고 가린다. 가린 뒤에는 한 줄로 줄이고 [다시 보기]·[닫기].
 * 카운트다운 숫자에는 aria-live 를 걸지 않는다(매초 읽힌다) — 가려질 때 한 번만 알린다.
 */
export function RevealPanel({ secret, onUntil, onLocked, onClose, onToast }: {
  secret: SecretView; onUntil: (iso: string) => void; onLocked: () => void; onClose: () => void; onToast: (text: string) => void;
}) {
  const t = useT();
  const [value, setValue] = useState<string | null>(null);
  const [left, setLeft] = useState(HIDE_AFTER_S);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    setValue(null); setHidden(false); setLeft(HIDE_AFTER_S); setError(null);
    getController().revealSecret(secret.id, { action: 'view', client: clientLabel() }).then((r) => {
      if (!live) return;
      onUntil(r.steppedUpUntil);
      setValue(r.value ?? '');
    }, (e) => {
      if (!live) return;
      if (e instanceof ApiError && e.status === 403) { onLocked(); return; }
      const wait = retryAfterSec(e);
      setError(wait !== null ? t('secrets.revealLimited', { n: String(Math.max(1, Math.ceil(wait / 60))) }) : t('secrets.revealFailed'));
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 다시 보기(round)마다 새로 받는다.
  }, [secret.id, round]);

  useEffect(() => {
    if (value === null || hidden) return;
    if (left <= 0) { setValue(null); setHidden(true); return; }
    const timer = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [value, left, hidden]);

  const copy = async () => {
    try {
      const r = await getController().revealSecret(secret.id, { action: 'copy', client: clientLabel() });
      onUntil(r.steppedUpUntil);
      const text = r.value ?? '';
      const concealed = await writeConcealed(text);
      if (!concealed) await copyText(text);
      onToast(concealed ? t('secrets.copiedCleared', { name: secret.name }) : t('secrets.copiedManual', { name: secret.name }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) { onLocked(); return; }
      setError(t('secrets.revealFailed'));
    }
  };

  return (
    <div className="mt-2 rounded border border-border bg-surface-sunken p-2" data-testid="secret-reveal">
      {error && <p role="alert" className="text-meta text-danger">{error}</p>}
      {hidden && (
        <div>
          <div className="flex flex-wrap items-center gap-2 text-meta" role="status">
            <span className="font-mono text-fg-subtle">••••</span>
            <span className="text-fg-muted">{t('secrets.revealHidden')}</span>
            <span className="ml-auto flex gap-1">
              <Button onClick={() => setRound((n) => n + 1)}>{t('secrets.revealAgain')}</Button>
              <Button onClick={onClose}>{t('secrets.close')}</Button>
            </span>
          </div>
          <p className="mt-1 text-meta text-fg-subtle">{t('secrets.revealAgainNote')}</p>
        </div>
      )}
      {!hidden && value !== null && (
        <div>
          <div className="flex items-center gap-2 text-meta">
            <span className="text-fg-muted" data-testid="secret-reveal-countdown">{t('secrets.revealCountdown', { n: String(left) })}</span>
            <span className="ml-auto flex gap-1">
              <Button onClick={() => void copy()}>{t('secrets.copy')}</Button>
              <Button onClick={() => { setValue(null); setHidden(true); }}>{t('secrets.hide')}</Button>
            </span>
          </div>
          <div className="mt-1 h-0.5 w-full bg-border" aria-hidden="true">
            <div className="h-0.5 bg-fg-subtle" style={{ width: `${(left / HIDE_AFTER_S) * 100}%` }} />
          </div>
          <pre className="mt-2 max-h-[10.5em] overflow-auto whitespace-pre-wrap break-all font-mono text-meta text-fg" data-testid="secret-reveal-value">{value}</pre>
        </div>
      )}
      {!hidden && value === null && !error && <p className="text-meta text-fg-muted">{t('secrets.loading')}</p>}
    </div>
  );
}

/** file 종류는 미리보기 없이 내려받기만 한다 — 바이너리를 글자로 보이면 깨지고 화면에 오래 남는다. */
export async function downloadSecretFile(secret: SecretView, onUntil: (iso: string) => void): Promise<void> {
  const r = await getController().revealSecret(secret.id, { action: 'download', client: clientLabel() });
  onUntil(r.steppedUpUntil);
  const bin = atob(r.valueBase64 ?? '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = r.filename ?? secret.filename ?? secret.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 아래쪽 짧은 알림(#1212 저장 토스트와 같은 모양: accent 없음, 가리키는 동안 멈춤). */
export function RevealToast({ text, onDone }: { text: string; onDone: () => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(onDone, 4000);
    return () => clearTimeout(timer);
  }, [paused, onDone, text]);
  return (
    <div role="status" data-testid="secrets-toast"
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}
      className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded bg-surface-raised px-3 py-2 text-meta text-fg shadow-float">
      {text}
    </div>
  );
}
