import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { compareRelease, type InviteView } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useLocale, useT } from '../../i18n/useT';
import { ApiError } from '../../lib/api';
import { errorText } from '../../lib/errorText';
import { SettingsGroup } from './primitives';

/**
 * 초대 메일·보낸 초대 목록이 다 든 서버 판(#1612 목록·취소 0.4.276, #1614 메일 0.4.278, #1620 재발송 보강 0.4.280).
 * 셋을 한 판으로 가른다 — 0.4.278 의 재발송은 같은 주소에 유효 토큰을 여럿 남길 수 있어(security n1) 그 앞 판에는
 * [다시 보내기]를 내지 않는다. 옛 서버는 지금 흐름(토큰 한 번 보이기)만 본다 — 하한을 올리지 않는다.
 */
export const INVITE_MAIL_SINCE = '0.4.280';

export function inviteMailSupported(version: string | null | undefined): boolean {
  return !!version && (compareRelease(version, INVITE_MAIL_SINCE) ?? -1) >= 0;
}

/** 칩 하나가 보낼 만한 주소인가. 서버(zod email)가 마지막으로 판정하고, 여기서는 눈에 띄는 오타만 거른다. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isEmail = (s: string) => EMAIL.test(s);

/** 서버의 다시 보내기 간격(`RESEND_GAP_SEC`). 버튼을 미리 잠가 429 를 보지 않게 한다. */
const RESEND_GAP_MS = 60_000;
/** 가입한 초대는 이만큼 지나면 목록에서 내린다 — 멤버 목록에 이미 있다(시안 1). */
const USED_KEEP_MS = 30 * 86_400_000;

type RowKind = 'sending' | 'sent' | 'pending' | 'used' | 'failed' | 'expired';

function rowKind(i: InviteView): RowKind {
  if (i.status === 'used') return 'used';
  if (i.status === 'expired') return 'expired';
  if (i.mailStatus === 'failed') return 'failed';
  return i.email ? 'sent' : 'pending';
}

const KIND_ORDER: Record<RowKind, number> = { sending: 0, failed: 1, expired: 2, sent: 3, pending: 4, used: 5 };
const KIND_CLASS: Record<RowKind, string> = {
  sending: 'bg-warning-surface text-warning',
  sent: 'bg-surface-raised text-link',
  pending: 'bg-surface-raised text-fg-muted',
  used: 'bg-success-surface text-success',
  failed: 'bg-danger-surface text-danger',
  expired: 'bg-surface-raised text-fg-subtle',
};
/**
 * 「손볼 것」은 **만료만** 센다(designer, 「실패면 취소」 뒤). 메일이 실패한 초대는 곧바로 거두므로 보통은 줄이 없고,
 * 거두기까지 실패해 남은 「보내지 못함」 줄은 빨간 칩과 [취소]로 이미 눈에 띈다.
 */
const isTodo = (k: RowKind) => k === 'expired';

/**
 * 토큰을 화면에 한 번 보여 주는 지금 흐름. 메일이 꺼진 서버·옛 서버에서는 이것이 주 동작이고, 메일이 켜진 서버에서는
 * 「메일 없이 토큰만 발급」 아래로 접힌다(시안 1). `primary` 가 아니면 버튼을 낮춘다.
 */
export function TokenInvite({ primary, onMinted }: { primary: boolean; onMinted?: () => void }) {
  const t = useT();
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const createInvite = async () => {
    setError(null);
    setToken(null);
    setBusy(true);
    try {
      const newToken = await getController().createInvite();
      setToken(newToken);
      onMinted?.();
    } catch (e) {
      setError(errorText(e, t, t('invite.failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {token && (
        <div className="mb-4 rounded-row border border-warning-border bg-warning-surface p-3">
          {/* 크기를 안 적어 본문단 13px 을 물려받는다 — "지금 안 적으면 다시 못 본다"는
              **놓치면 되돌릴 수 없는** 문장이다. 아래 토큰 자체는 등폭 11px 이라 이 경고와
              값이 두 단으로 갈린다. */}
          <div className="font-semibold text-warning">
            {t('invite.tokenWarning')}
          </div>
          <code className="mt-1 block break-all rounded-row bg-surface-raised p-2 text-meta">{token}</code>
          <div className="mt-2 text-meta text-warning">
            {t('invite.tokenNextStep')}
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-row border border-danger-border bg-danger-surface p-3">
          <p className="text-meta text-danger">{error}</p>
        </div>
      )}

      <button
        className={primary
          ? 'rounded-row bg-accent px-4 py-2 font-medium text-fg-on-strong disabled:opacity-50'
          : 'rounded-row border border-border-strong px-3 py-1 text-fg disabled:opacity-50'}
        // 토큰이 하나 나왔다고 버튼을 잠그지 않는다 — 초대는 여러 사람에게 하는 일이고,
        // 토큰은 한 번 쓰면 소진되므로 두 번째 사람에게는 새 토큰이 필요하다. 다시 누르면
        // 앞 토큰은 화면에서 사라지므로(다시 볼 수 없다) 그 사실을 라벨로 알린다.
        disabled={busy}
        onClick={() => void createInvite()}
      >
        {busy ? t('invite.busy') : token ? t('invite.createAgain') : t('invite.create')}
      </button>
    </>
  );
}

/**
 * 초대 칸(서버 0.4.280~). 메일이 켜진 서버면 이메일 칩 입력 + [초대 메일 보내기], 토큰 발급은 접어 남긴다.
 * 꺼진 서버면 그 사실을 말하고 지금 흐름을 그대로 보인다. 어느 쪽이든 「보낸 초대」 목록이 아래에 선다 —
 * 화면에 한 번 보였던 토큰도 여기서 거둔다(#1612).
 */
export function InviteMailPanel({ lead }: { lead?: ReactNode } = {}) {
  const t = useT();
  const locale = useLocale();
  const lang: 'ko' | 'en' = locale === 'ko' ? 'ko' : 'en';
  const [mail, setMail] = useState<'loading' | 'on' | 'off'>('loading');
  const [invites, setInvites] = useState<InviteView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [chips, setChips] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState<string[]>([]);
  const [result, setResult] = useState<{ sent: number; failed: { email: string; reason: string; stuck?: boolean }[] } | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowMessage, setRowMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [filter, setFilter] = useState<'all' | 'todo' | 'used'>('all');
  const [now, setNow] = useState(() => Date.now());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    getController().inviteMailStatus().then((m) => { if (alive) setMail(m); }, () => { if (alive) setMail('off'); });
    return () => { alive = false; };
  }, []);

  const reload = useCallback(async () => {
    try {
      setInvites(await getController().invites());
      setListError(null);
    } catch (e) {
      setListError(errorText(e, t));
    }
    setNow(Date.now());
  }, [t]);
  useEffect(() => { void reload(); }, [reload]);

  // 다시 보내기의 1분 잠금이 풀리는 것을 보이려고 30초마다 시계를 다시 읽는다.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const pendingByEmail = useMemo(() => {
    const m = new Map<string, InviteView>();
    for (const i of invites ?? []) if (i.email && i.status === 'pending') m.set(i.email, i);
    return m;
  }, [invites]);

  /** 입력칸의 글을 칩으로 옮긴다(쉼표·세미콜론·공백으로 나눈다, 대소문자 무시로 겹치지 않게). */
  const take = (text: string): string[] => {
    const parts = text.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const next = [...chips];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    setChips(next);
    setDraft('');
    return next;
  };

  /**
   * 메일이 나가지 못한 초대는 **곧바로 거둔다**(jaebin 결정, 카드 8e864edd). 서버는 그 초대의 토큰을 응답에 싣지만
   * 화면은 그것을 쓰지도 남기지도 않으므로, 두면 아무도 모르는 토큰이 7일 산다. 주소는 칩으로 돌려 다시 보내게 한다.
   * 거두기까지 실패하면 `false` — 그 초대는 「보내지 못함」 줄로 목록에 남고, 사람이 그 줄의 [취소]로 거둔다.
   */
  const withdraw = async (id: string): Promise<boolean> => {
    try {
      await getController().revokeInvite(id);
      return true;
    } catch {
      return false;
    }
  };

  const send = async () => {
    const all = draft.trim() ? take(draft) : chips;
    const good = all.filter(isEmail);
    if (good.length === 0 || sending.length) { input.current?.focus(); return; }
    setResult(null);
    setRowMessage(null);
    setSending(good);
    let sent = 0;
    const failed: { email: string; reason: string; stuck?: boolean }[] = [];
    // 한 사람씩 보낸다 — 서버는 보내는 사람당 시간당 상한을 직렬로 세고, 한 통이 느려도(최대 45초) 결과를 사람마다 가른다.
    for (const email of good) {
      const pending = pendingByEmail.get(email);
      try {
        // 이미 초대 중인 주소면 「보내기 = 다시 보내기」다(시안 2d) — 앞 링크는 무효가 되고 7일이 새로 시작한다.
        const r = pending
          ? await getController().resendInvite(pending.id, lang)
          : await getController().sendInvite(email, lang);
        if (r.mail === 'sent') sent += 1;
        else failed.push({ email, reason: t('invite.status.failed'), stuck: !(await withdraw(r.id)) });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'mail_disabled') {
          // 연 뒤에 서버 설정이 꺼졌다 — 지금 흐름으로 물러난다.
          setMail('off');
        }
        failed.push({ email, reason: errorText(e, t) });
      }
      setSending((s) => s.filter((x) => x !== email));
    }
    // 성공한 사람은 칩에서 빼고, 실패한 주소·형식이 틀린 주소만 남겨 고쳐 다시 보내게 한다(시안 2b, c2).
    const failedSet = new Set(failed.map((f) => f.email));
    setChips(all.filter((e) => !isEmail(e) || failedSet.has(e)));
    setResult({ sent, failed });
    await reload();
    input.current?.focus();
  };

  const act = async (row: InviteView, kind: 'resend' | 'revoke') => {
    setRowBusy(row.id);
    setRowMessage(null);
    try {
      if (kind === 'resend') {
        const r = await getController().resendInvite(row.id, lang);
        if (r.mail === 'sent') {
          setRowMessage({ kind: 'ok', text: t('invite.mail.sentToast', { count: '1' }) });
        } else {
          // 서버는 앞 초대를 이미 취소하고 새 초대를 만들었다 — 새 것도 거두고 주소를 칩으로 돌린다(위 `withdraw`).
          const stuck = !(await withdraw(r.id));
          if (row.email) setChips((c) => (c.includes(row.email!) ? c : [...c, row.email!]));
          setRowMessage({ kind: 'error', text: [
            t('invite.mail.someFailed', { count: '1' }),
            t('invite.mail.someFailedNext'),
            ...(stuck ? [t('invite.mail.withdrawFailed', { count: '1' })] : []),
          ].join(' ') });
        }
      } else {
        await getController().revokeInvite(row.id);
        setRowMessage({ kind: 'ok', text: t('invite.action.revoked') });
      }
    } catch (e) {
      setRowMessage({ kind: 'error', text: t('invite.action.failed', { reason: errorText(e, t) }) });
    } finally {
      setRowBusy(null);
      await reload();
    }
  };

  const rows = useMemo(() => {
    const list = (invites ?? [])
      // 취소된 초대(사람이 거뒀거나 다시 보내기로 바뀐 것)는 싣지 않는다 — 살아 있는 것과 손볼 것만 본다.
      .filter((i) => i.status !== 'revoked')
      .filter((i) => i.status !== 'used' || now - Date.parse(i.createdAt) < USED_KEEP_MS)
      .map((i) => ({ invite: i, kind: rowKind(i) }));
    list.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || Date.parse(b.invite.createdAt) - Date.parse(a.invite.createdAt));
    return list;
  }, [invites, now]);
  const counts = {
    all: rows.length,
    todo: rows.filter((r) => isTodo(r.kind)).length,
    used: rows.filter((r) => r.kind === 'used').length,
  };
  const shown = rows.filter((r) => filter === 'all' || (filter === 'todo' ? isTodo(r.kind) : r.kind === 'used'));

  const goodCount = chips.filter(isEmail).length + (draft.trim() && isEmail(draft.trim().toLowerCase()) ? 1 : 0);
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale, { month: '2-digit', day: '2-digit' });
  const subFor = (i: InviteView, kind: RowKind): string => {
    if (kind === 'used') return t('invite.sub.joined', { handle: i.usedBy?.handle ?? '' });
    if (kind === 'expired') return i.expiresAt ? t('invite.sub.expiredAt', { date: date(i.expiresAt) }) : '';
    // 보내지 못한 줄에 「보냄 · N일 남음」을 쓰면 상태 칩과 어긋난다(designer s1) — 실패 시각만 쓴다.
    if (kind === 'failed') return t('invite.sub.failedAt', { date: date(i.lastSentAt ?? i.createdAt) });
    const when = i.lastSentAt ? t('invite.sub.sentAt', { date: date(i.lastSentAt) }) : t('invite.sub.createdAt', { date: date(i.createdAt) });
    if (!i.expiresAt) return when;
    const days = Math.floor((Date.parse(i.expiresAt) - now) / 86_400_000);
    return `${when} · ${days >= 1 ? t('invite.sub.daysLeft', { days: String(days) }) : t('invite.sub.hoursLeft')}`;
  };
  const btn = 'rounded-row border border-border-strong px-2 py-0.5 text-meta text-fg hover:bg-surface-hover disabled:opacity-50';

  return (
    <>
      <SettingsGroup title={t('members.invite.title')}>
        <div className="px-4 py-3" data-testid="members-invite">
          {lead}
          {mail === 'off' && (
            <div className="mb-3 rounded-row border border-warning-border bg-warning-surface p-3 text-meta text-warning" data-testid="invite-mail-off">
              {t('invite.mail.off')} <span className="text-fg-subtle">{t('invite.mail.offOwner')}</span>
            </div>
          )}
          {mail === 'off' && <TokenInvite primary onMinted={() => void reload()} />}

          {mail === 'on' && (
            <>
              <label className="mb-1 block font-semibold" htmlFor="invite-email-input">{t('invite.mail.label')}</label>
              <input
                id="invite-email-input"
                ref={input}
                data-testid="invite-email-input"
                className="w-full min-w-0 rounded-row border border-border-strong bg-field px-2 py-1.5 text-fg"
                placeholder={t('invite.mail.placeholder')}
                autoComplete="off"
                inputMode="email"
                value={draft}
                onChange={(e) => {
                  const v = e.target.value;
                  // 붙여 넣은 목록·쉼표는 곧바로 칩으로 옮긴다.
                  if (/[,;\s]/.test(v)) take(v); else setDraft(v);
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter') { e.preventDefault(); if (draft.trim()) take(draft); else void send(); }
                  else if (e.key === 'Backspace' && !draft && chips.length) setChips(chips.slice(0, -1));
                }}
                onBlur={() => { if (draft.trim()) take(draft); }}
              />
              {chips.length > 0 && (
                <ul className="mt-1.5 flex flex-wrap gap-1" data-testid="invite-email-chips">
                  {chips.map((e) => {
                    const bad = !isEmail(e);
                    const pending = !bad && pendingByEmail.has(e);
                    return (
                      <li key={e} data-testid={`invite-chip-${e}`}
                        className={`flex max-w-full items-center gap-1 rounded-full border py-px pl-2 pr-1 text-meta ${bad
                          ? 'border-danger-border bg-danger-surface text-danger'
                          : 'border-border bg-surface-raised text-fg'}`}>
                        <span className="min-w-0 truncate" title={e}>
                          {e}{bad ? ` · ${t('invite.mail.badAddress')}` : pending ? ` · ${t('invite.mail.pendingChip')}` : ''}
                        </span>
                        <button type="button" className="px-1" aria-label={t('invite.mail.removeChip', { email: e })}
                          onClick={() => { setChips(chips.filter((x) => x !== e)); input.current?.focus(); }}>×</button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="mt-1 text-meta text-fg-subtle">{t('invite.mail.hint')}</p>

              {result && result.sent > 0 && (
                <p role="status" className="mt-2 rounded-row bg-success-surface p-2 text-meta text-success" data-testid="invite-mail-sent">
                  ✓ {t('invite.mail.sentToast', { count: String(result.sent) })}
                </p>
              )}
              {result && result.failed.length > 0 && (
                <div role="alert" className="mt-2 rounded-row border border-danger-border bg-danger-surface p-2 text-meta text-danger" data-testid="invite-mail-failed">
                  <b>{t('invite.mail.someFailed', { count: String(result.failed.length) })}</b>
                  <ul className="mt-1">
                    {result.failed.map((f) => <li key={f.email} className="truncate" title={f.email}>{f.email} — {f.reason}</li>)}
                  </ul>
                  <p className="mt-1">{t('invite.mail.someFailedNext')}</p>
                  {result.failed.some((f) => f.stuck) && (
                    <p className="mt-1 font-semibold" data-testid="invite-mail-withdraw-failed">
                      {t('invite.mail.withdrawFailed', { count: String(result.failed.filter((f) => f.stuck).length) })}
                    </p>
                  )}
                </div>
              )}

              <button
                className="mt-3 w-full rounded-row bg-accent px-4 py-2 font-medium text-fg-on-strong disabled:opacity-50"
                data-testid="invite-mail-send"
                disabled={sending.length > 0 || (chips.length > 0 && goodCount === 0)}
                onClick={() => void send()}
              >
                {sending.length > 0
                  ? t('invite.mail.sending')
                  : goodCount > 1 ? t('invite.mail.sendMany', { count: String(goodCount) }) : t('invite.mail.send')}
              </button>

              <div className="my-3 h-px bg-border" />
              <details data-testid="invite-token-only">
                <summary className="cursor-pointer text-meta text-fg-subtle">{t('invite.mail.tokenOnly')}</summary>
                <p className="my-2 text-meta text-fg-subtle">{t('invite.mail.tokenOnlyNote')}</p>
                <TokenInvite primary={false} onMinted={() => void reload()} />
              </details>
            </>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title={`${t('invite.list.title')}${invites ? ` ${counts.all}` : ''}`}>
        <div className="px-4 py-2" data-testid="invite-list">
          {rowMessage && (
            <p role={rowMessage.kind === 'ok' ? 'status' : 'alert'}
              className={`mb-2 rounded-row p-2 text-meta ${rowMessage.kind === 'ok' ? 'bg-success-surface text-success' : 'bg-danger-surface text-danger'}`}>
              {rowMessage.text}
            </p>
          )}
          {listError && <p role="alert" className="text-meta text-danger">{t('invite.list.failed')}: {listError}</p>}
          {!invites && !listError && <p className="text-meta text-fg-subtle">{t('invite.list.loading')}</p>}
          {invites && rows.length === 0 && sending.length === 0 && <p className="text-meta text-fg-subtle">{t('invite.list.empty')}</p>}
          {invites && rows.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1" role="group" aria-label={t('invite.list.filterLabel')}>
              {(['all', 'todo', 'used'] as const).map((f) => (
                <button key={f} type="button" aria-pressed={filter === f} data-testid={`invite-filter-${f}`}
                  onClick={() => setFilter(f)}
                  className={`rounded-full border px-2 text-meta ${filter === f ? 'border-border-strong bg-surface-raised text-fg' : 'border-border text-fg-subtle'}`}>
                  {t(f === 'all' ? 'invite.list.filterAll' : f === 'todo' ? 'invite.list.filterTodo' : 'invite.list.filterUsed', { count: String(counts[f]) })}
                </button>
              ))}
            </div>
          )}
          <ul>
            {sending.map((email) => (
              <li key={`sending-${email}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 border-t border-border py-2 first:border-t-0">
                <span className="truncate font-medium" title={email}>{email}</span>
                <span className={`whitespace-nowrap rounded-full px-1.5 text-meta font-semibold ${KIND_CLASS.sending}`}>{t('invite.status.sending')}</span>
              </li>
            ))}
            {shown.map(({ invite: i, kind }) => {
              const who = i.email ?? t('invite.list.tokenOnly');
              const live = kind === 'sent' || kind === 'failed' || kind === 'pending';
              // 메일이 꺼진 서버에서는 다시 보내기를 내지 않는다(누를 수 없는 버튼을 세워 두지 않는다).
              const canResend = !!i.email && kind !== 'used' && mail === 'on';
              const wait = !!i.lastSentAt && now - Date.parse(i.lastSentAt) < RESEND_GAP_MS;
              return (
                <li key={i.id} data-testid={`invite-row-${i.id}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-0.5 border-t border-border py-2 first:border-t-0">
                  <span className="truncate font-medium" title={who}>{who}</span>
                  <span className={`whitespace-nowrap rounded-full px-1.5 text-meta font-semibold ${KIND_CLASS[kind]}`} data-testid={`invite-status-${i.id}`}>
                    {t(`invite.status.${kind}`)}
                  </span>
                  <span className="col-span-2 flex flex-wrap items-center gap-1.5 text-meta text-fg-subtle">
                    <span>{subFor(i, kind)}</span>
                    {(canResend || live) && (
                      <span className="ml-auto flex items-center gap-1">
                        {canResend && (
                          <button type="button" className={btn} data-testid={`invite-resend-${i.id}`}
                            disabled={rowBusy === i.id || wait}
                            title={wait ? t('invite.action.resendWait') : undefined}
                            onClick={() => void act(i, 'resend')}>
                            {kind === 'expired' ? t('invite.action.sendNew') : t('invite.action.resend')}
                          </button>
                        )}
                        {live && (
                          <button type="button" className={btn} data-testid={`invite-revoke-${i.id}`}
                            disabled={rowBusy === i.id}
                            aria-label={t('invite.action.revokeLabel', { who })}
                            onClick={() => void act(i, 'revoke')}>
                            {t('invite.action.revoke')}
                          </button>
                        )}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </SettingsGroup>
    </>
  );
}
