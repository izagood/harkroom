import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountView } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { ApiError, type SecretAccessView, type SecretGrantView, type SecretView } from '../../lib/api';
import { useLocale, useT } from '../../i18n/useT';
import { ConfirmDialog } from '../ConfirmDialog';
import { Menu, type MenuItem } from '../Menu';
import { Button, Field, Segmented, SettingsPage, TextInput } from './primitives';
import { ConnectorsSection } from './ConnectorsSection';
import { SecretAgentPicker } from './SecretAgentPicker';
import { Identity } from '../Identity';
import { downloadSecretFile, RevealPanel, RevealToast, UnlockDialog, UnlockHeader, useRevealSupported, type Ticket, type UnlockState } from './SecretReveal';

/**
 * 설정 › 나 › **비밀과 API** — 비밀 절(외부 API 권한 C안 P1, 스레드 07519d86 · designer v3 ①).
 *
 * 서버 REST(`secretRoutes.ts`, 085)는 이미 있었고 화면이 없었다. 키를 넣을 곳이 없으면 키는 채팅 평문으로
 * 돌고, 에이전트는 옛 글을 검색해 꺼낸다. 이 화면이 그 자리를 채운다.
 *
 * 지키는 것:
 * - **값은 소유자만, 잠금을 푼 뒤에만 다시 본다**(114, `SecretReveal.tsx`). 그 밖의 응답에는 값·해시가 없다.
 *   넣기·바꾸기가 끝나면 입력 상태를 바로 비운다.
 * - **판정은 전부 서버다.** 부여는 소유자만, 지우기·거두기는 소유자나 admin — 화면은 버튼을 숨기는
 *   편의만 하고 거절은 서버 말을 사람 말로 옮긴다(`AgentGrantsSection` 머리 주석과 같은 이유).
 * - 지우기는 **발급처의 키 폐기가 아니다** — 확인창이 그렇게 말한다.
 *
 * 「쓰는 곳」(designer v3)은 지금은 파일로 받는 에이전트 수다. API 연결(P2)이 붙으면 그 연결 이름이 더해진다.
 */

type Expiry = 'none' | '30d' | '90d' | 'date';
/** 줄 위에 여는 것(값 보기·값 바꾸기). 펼침 탭(받는 에이전트·접근 기록)과는 따로 연다. */
type Panel = { id: string; kind: 'reveal' | 'replace' } | null;
type Tab = 'grants' | 'access';
/** 만료가 이만큼 안으로 들어오면 경고색(designer 시안 v1 #3). */
const SOON_MS = 14 * 86_400_000;

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

export function SecretsSettings({ targetId }: { targetId?: string } = {}) {
  const t = useT();
  const locale = useLocale();
  const me = useActiveStore((s) => s.me);
  const [state, setState] = useState<{ enabled: boolean; secrets: SecretView[] } | 'loading' | 'error'>('loading');
  const [adding, setAdding] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [open, setOpen] = useState<{ id: string; tab: Tab } | null>(null);
  const [helpOn, setHelpOn] = useState(false);
  const [deleting, setDeleting] = useState<SecretView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─── 소유자 보기(114): 보관소 단위 잠금 해제 ───
  const revealSupported = useRevealSupported();
  const [unlock, setUnlock] = useState<UnlockState>({ until: null, autoLocked: false });
  const [unlockAsk, setUnlockAsk] = useState<{ thenId: string | null } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const untilRef = useRef<number | null>(null);
  untilRef.current = unlock.until;
  const onUntil = useCallback((iso: string) => setUnlock({ until: Date.parse(iso), autoLocked: false }), []);
  /** 잠금 세대(security n1) — 잠글 때마다 오르고, 그 앞에서 시작한 요청의 결과는 버린다. */
  const gen = useRef(0);
  const ticket = useCallback((): Ticket => {
    const g = gen.current;
    return { live: () => g === gen.current, until: (iso) => { if (g === gen.current) onUntil(iso); } };
  }, [onUntil]);
  /**
   * 잠그기 — 화면부터 잠그고 서버 창은 기다리지 않고 끝낸다(멱등).
   * `user`·`auto` 는 DELETE 를 보낸다(n2: 시계가 서버보다 빠르면 서버 창이 더 열려 있을 수 있다).
   * `server` 는 서버가 이미 403 으로 잠겼다고 말한 경우라 보내지 않는다.
   */
  const lock = useCallback((why: 'user' | 'auto' | 'server' = 'user') => {
    gen.current += 1;
    const wasOpen = untilRef.current !== null;
    setUnlock({ until: null, autoLocked: why !== 'user' });
    setPanel((p) => (p?.kind === 'reveal' ? null : p));
    if (wasOpen && why !== 'server') void getController().lockSecrets().catch(() => {});
  }, []);
  // 서버가 준 끝 시각이 지나면 잠긴 것으로 그리고 열린 값 패널을 닫는다(머리줄은 aria-live 로 한 번 알린다).
  useEffect(() => {
    if (unlock.until === null) return;
    const timer = setTimeout(() => lock('auto'), Math.max(0, unlock.until - Date.now()));
    return () => clearTimeout(timer);
  }, [unlock.until, lock]);
  // 앱을 숨기면 잠근다. 설정을 닫으면(언마운트) 서버 창도 끝낸다.
  useEffect(() => {
    const onVis = () => { if (document.hidden && untilRef.current !== null) lock(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (untilRef.current !== null) void getController().lockSecrets().catch(() => {});
    };
  }, [lock]);

  const load = useCallback(async () => {
    try { setState(await getController().listSecrets()); } catch { setState('error'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  /**
   * 알림 줄 [비밀 보기](designer n3)가 넘긴 비밀 id — 목록이 오면 그 줄로 스크롤하고 잠깐 강조한다. 한 targetId 에 한 번만
   * (`AgentsSettings` 와 같은 이유: 목록은 다시 읽을 때마다 새 배열이다). 없는 id(지워졌거나 남의 것)면 아무것도 안 한다.
   */
  const [flash, setFlash] = useState<string | null>(null);
  const jumpedFor = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => {
    if (!targetId || jumpedFor.current === targetId || typeof state !== 'object') return;
    jumpedFor.current = targetId;
    if (!state.secrets.some((s) => s.id === targetId)) return;
    rowRefs.current.get(targetId)?.scrollIntoView?.({ block: 'center' });
    setFlash(targetId);
  }, [targetId, state]);
  // 강조 끄기는 따로 건다 — 위 효과는 목록을 다시 읽을 때마다 다시 돌아 그 정리가 타이머를 지우면 강조가 남는다.
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 2000);
    return () => clearTimeout(timer);
  }, [flash]);

  const explain = useExplain();
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true); setError(null);
    try { await fn(); await load(); return true; } catch (e) { setError(explain(e)); return false; } finally { setBusy(false); }
  };

  const secrets = typeof state === 'object' ? state.secrets : [];
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale);

  return (
    <SettingsPage section="secrets" description={<>{t('secrets.description')}{' '}<HelpToggle on={helpOn} onToggle={() => setHelpOn(!helpOn)} /></>} layout="list">
      {helpOn && <SecretsHelp />}
      {state === 'loading' && <p className="text-meta text-fg-muted">{t('secrets.loading')}</p>}
      {state === 'error' && <p role="alert" className="text-meta text-danger">{t('secrets.listFailed')}</p>}
      {typeof state === 'object' && !state.enabled && (
        <p className="mb-3 rounded bg-warning-surface px-3 py-2 text-meta text-warning" data-testid="secrets-disabled">{t('secrets.disabled')}</p>
      )}

      {typeof state === 'object' && (
        <section className="mt-6" data-testid="secrets">
          {/* 절 머리는 테두리 없는 제목줄, 테두리는 목록 하나에만(designer 시안 v1 #7). 주 버튼은 「+ 비밀 넣기」 하나(#6). */}
          <div className="mb-2 flex flex-wrap items-center gap-2.5">
            <h3 className="text-meta font-semibold text-fg">{t('secrets.heading')}</h3>
            <span className="text-meta text-fg-subtle">{secrets.length}</span>
            {revealSupported && state.enabled && secrets.some((x) => x.ownerAccountId === me?.id) && (
              <UnlockHeader unlock={unlock} onLock={() => lock()} />
            )}
            <span className="ml-auto">
              {state.enabled && !adding && <Button variant="primary" onClick={() => { setAdding(true); setError(null); }} disabled={busy}>{t('secrets.add')}</Button>}
            </span>
          </div>

          {adding && (
            <CreateForm
              busy={busy}
              onCancel={() => setAdding(false)}
              onSubmit={async (body) => { if (await run(async () => { await getController().createSecret(body); })) setAdding(false); }}
            />
          )}

          {secrets.length === 0 && !adding && <p className="mt-2 text-meta text-fg-subtle" data-testid="secrets-none">{t('secrets.none')}</p>}

          {secrets.length > 0 && (
          // 비밀은 한 줄 격자 목록(비밀과 API 개선 B #1269) — 넓은 창에서는 칸으로 나누지 않고 list 폭을 꽉 채운다.
          <ul className="divide-y divide-border rounded-card border border-border" data-testid="secrets-list">
            {secrets.map((s) => {
              const expiresMs = s.expiresAt === null ? null : Date.parse(s.expiresAt);
              const expired = expiresMs !== null && expiresMs <= Date.now();
              const expiringSoon = expiresMs !== null && !expired && expiresMs - Date.now() <= SOON_MS;
              const mine = s.ownerAccountId === me?.id;
              const shown = panel?.id === s.id ? panel.kind : null;
              const tab = open?.id === s.id ? open.tab : null;
              const setTab = (next: Tab | null) => { setError(null); setOpen(next ? { id: s.id, tab: next } : null); };
              const locked = unlock.until === null;
              /** [값 보기]·[내려받기] — 잠겨 있으면 확인 창 하나(풀리면 이 행을 바로 연다), 풀려 있으면 바로. */
              const reveal = () => {
                setError(null);
                if (locked) { setUnlockAsk({ thenId: s.id }); return; }
                if (s.kind === 'file') {
                  const tk = ticket();
                  void downloadSecretFile(s, tk).then(
                    (ok) => { if (ok) setToast(t('secrets.downloaded', { name: s.filename ?? s.name })); },
                    (e) => {
                      if (!tk.live()) return;
                      if (e instanceof ApiError && e.status === 403) { lock('server'); setUnlockAsk({ thenId: s.id }); } else setError(explain(e));
                    },
                  );
                  return;
                }
                setPanel(shown === 'reveal' ? null : { id: s.id, kind: 'reveal' });
              };
              const menu: MenuItem[] = [
                ...(mine && state.enabled ? [{ label: t('secrets.replace'), onSelect: () => { setError(null); setPanel({ id: s.id, kind: 'replace' }); } }] : []),
                { label: t('secrets.access'), onSelect: () => setTab('access') },
                { label: t('secrets.deleteMenu'), onSelect: () => setDeleting(s), tone: 'danger', separatorBefore: true },
              ];
              const sub = [s.filename, s.description].filter(Boolean).join(' · ');
              return (
                <li key={s.id} ref={(el) => { if (el) rowRefs.current.set(s.id, el); else rowRefs.current.delete(s.id); }}
                  className={`text-meta transition-colors first:rounded-t-card last:rounded-b-card ${flash === s.id ? 'bg-accent-surface' : tab ? 'bg-surface-sunken' : ''}`}
                  data-testid={`secret-${s.name}`} data-flash={flash === s.id || undefined}>
                  {/* 한 줄 격자: ▸ · 이름(굵게)+설명 · 받는 에이전트 · 만료 · [값 보기] ⋯ (#3). 줄을 누르면 펼친다. */}
                  <div className={`grid cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2 sm:grid-cols-[16px_minmax(0,1fr)_7.5rem_7.5rem] ${tab ? '' : 'hover:bg-surface-hover'} ${expired ? 'text-fg-subtle' : 'text-fg'}`}
                    onClick={() => setTab(tab ? null : 'grants')}>
                    <button type="button" aria-expanded={tab !== null} aria-label={t('secrets.expandAria', { name: s.name })}
                      data-testid={`secret-expand-${s.name}`}
                      className={`text-fg-subtle transition-transform ${tab ? 'rotate-90' : ''}`}
                      onClick={(e) => { e.stopPropagation(); setTab(tab ? null : 'grants'); }}>▸</button>
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-x-2">
                        <span className="min-w-0 truncate font-mono text-body font-semibold" title={s.name}>{s.name}</span>
                        {s.kind === 'file' && <span className="shrink-0 whitespace-nowrap rounded bg-surface-raised px-1 text-fg-muted">{t('secrets.kindFile')}</span>}
                        <span className="shrink-0 whitespace-nowrap"><AgentMadeBadge secret={s} /></span>
                      </span>
                      {sub && <span className="block truncate text-fg-subtle">{sub}</span>}
                    </span>
                    {/* 쓰는 곳·만료를 오른쪽 정렬 한 칸에 두 줄로(designer m2) — 열은 맞추면서 이름 칸을 넓게 둔다. */}
                    <span className="hidden min-w-0 text-right leading-tight sm:block">
                      <span className="block truncate text-fg-muted" data-testid={`secret-used-${s.name}`}
                        title={s.grantCount > 0 ? t('secrets.usedBy', { n: String(s.grantCount) }) : undefined}>
                        {s.grantCount > 0 ? t('secrets.usedByShort', { n: String(s.grantCount) }) : <span className="text-fg-subtle">{t('secrets.unused')}</span>}
                      </span>
                      <span className={`block truncate ${expired || expiringSoon ? 'text-warning' : 'text-fg-subtle'}`} data-testid={`secret-expiry-${s.name}`}
                        data-soon={expiringSoon || undefined}>
                        {expired
                          ? t('secrets.expired', { when: date(s.expiresAt as string) })
                          : s.expiresAt ? t('secrets.until', { when: date(s.expiresAt) }) : t('secrets.noExpiry')}
                      </span>
                    </span>
                    <span className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                      {mine && state.enabled && revealSupported && (
                        <SmallButton onClick={reveal} disabled={busy} pressed={shown === 'reveal'} className="inline-flex min-w-[5.25rem] items-center justify-center gap-1"
                          ariaLabel={t(s.kind === 'file' ? 'secrets.downloadAria' : 'secrets.revealAria', { name: s.name })}>
                          {/* 잠겨 있을 때만 단색 자물쇠(designer n7) — 컬러 이모지는 버튼 사이에서 혼자 튀었다. */}
                          {locked && <LockGlyph />}
                          {s.kind === 'file' ? t('secrets.download') : t('secrets.reveal')}
                        </SmallButton>
                      )}
                      {/* Menu 는 가장 가까운 positioned 조상에 붙는다 — 여기 relative 가 없으면 페이지 끝으로 날아간다. */}
                      <span className="relative">
                      <Menu placement="bottom" className="right-0" items={menu} renderTrigger={(p) => (
                        <button type="button" {...p} aria-label={t('secrets.moreAria', { name: s.name })} data-testid={`secret-more-${s.name}`}
                          disabled={busy}
                          className="h-7 w-7 rounded-row text-body leading-none text-fg-muted hover:bg-surface-hover hover:text-fg disabled:opacity-50">⋯</button>
                      )} />
                      </span>
                    </span>
                  </div>
                  {(shown || tab) && (
                    <div className="px-3 pb-3 sm:pl-10">
                      {shown === 'reveal' && (
                        <RevealPanel secret={s} ticket={ticket} onClose={() => setPanel(null)} onToast={setToast}
                          onLocked={() => { lock('server'); setUnlockAsk({ thenId: s.id }); }} />
                      )}
                      {shown === 'replace' && (
                        <ReplaceForm secret={s} busy={busy} onCancel={() => setPanel(null)}
                          onSubmit={async (body) => { if (await run(async () => { await getController().replaceSecretValue(s.id, body); })) setPanel(null); }} />
                      )}
                      {tab && (
                        <>
                          {/* 펼침 탭(D2): 받는 에이전트 / 접근 기록. 버튼 다섯 개가 있던 자리다(#2). */}
                          <div role="tablist" aria-label={s.name} className={`inline-flex gap-0.5 rounded-row bg-surface p-0.5 ${shown ? 'mt-2' : ''}`}>
                            {(['grants', 'access'] as const).map((k) => (
                              <button key={k} type="button" role="tab" aria-selected={tab === k} data-testid={`secret-tab-${k}`}
                                className={`rounded-row px-2.5 py-0.5 text-meta ${tab === k ? 'bg-surface-raised text-fg' : 'text-fg-muted hover:text-fg'}`}
                                onClick={() => setTab(k)}>
                                {k === 'grants' ? t('secrets.tabGrants', { n: String(s.grantCount) }) : t('secrets.access')}
                              </button>
                            ))}
                          </div>
                          {tab === 'grants' && <GrantsPanel secret={s} canGrant={mine && !expired} expiredMine={mine && expired} onChanged={load} />}
                          {tab === 'access' && <AccessPanel secret={s} />}
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          )}
          {error && <p role="alert" className="mt-2 text-meta text-danger" data-testid="secrets-error">{error}</p>}
        </section>
      )}

      {unlockAsk && (
        <UnlockDialog
          thenName={unlockAsk.thenId ? (secrets.find((x) => x.id === unlockAsk.thenId)?.name ?? null) : null}
          onCancel={() => setUnlockAsk(null)}
          onDone={(until) => {
            const thenId = unlockAsk.thenId;
            setUnlockAsk(null);
            onUntil(until);
            const target = thenId ? secrets.find((x) => x.id === thenId) : undefined;
            if (target?.kind === 'text') setPanel({ id: target.id, kind: 'reveal' });
            else if (target?.kind === 'file') {
              const tk = ticket();
              void downloadSecretFile(target, tk).then(
                (ok) => { if (ok) setToast(t('secrets.downloaded', { name: target.filename ?? target.name })); },
                (e) => { if (tk.live()) setError(explain(e)); },
              );
            }
          }}
        />
      )}
      {toast && <RevealToast text={toast} onDone={() => setToast(null)} />}

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
            if (open?.id === s.id) setOpen(null);
            void run(() => getController().deleteSecret(s.id));
          }}
        />
      )}
    </SettingsPage>
  );
}

/**
 * 머리 설명은 한 줄(SettingsPage description), 나머지는 「어떻게 지켜지나」를 눌러야 펼친다(designer 시안 v1 #5).
 * 패널마다 붙어 있던 설명 문단(grantsNote)도 여기로 모였다.
 */
function HelpToggle({ on, onToggle }: { on: boolean; onToggle(): void }) {
  const t = useT();
  // 설명 문장 끝에 붙는다(designer n8) — 따로 줄을 차지하면 위아래 여백만 커진다.
  return (
    <button type="button" aria-expanded={on} data-testid="secrets-help-toggle"
      className="text-fg-muted underline decoration-dotted underline-offset-2 hover:text-fg"
      onClick={onToggle}>{t('secrets.helpToggle')}</button>
  );
}

function SecretsHelp() {
  const t = useT();
  return (
    <ul className="-mt-6 mb-6 list-disc space-y-0.5 rounded-card bg-surface-sunken py-2 pl-7 pr-3 text-meta text-fg-muted" data-testid="secrets-help">
      <li>{t('secrets.help1')}</li>
      <li>{t('secrets.help2')}</li>
      <li>{t('secrets.help3')}</li>
    </ul>
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
        case 'not_own_agent': return t('secrets.errNotOwnAgent');
        case 'secret_expired': return t('secrets.errExpired');
        case 'not_assigned': return t('secrets.errNotAssigned');
        default: break;
      }
      if (err.status === 403) return t('secrets.errForbidden');
    }
    return t('secrets.errFailed', { reason: err instanceof Error ? err.message : String(err) });
  };
}

function LockGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3 text-fg-muted" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

function SmallButton({ children, onClick, disabled, danger, pressed, ariaLabel, className = '' }: {
  children: React.ReactNode; onClick(): void; disabled?: boolean; danger?: boolean; pressed?: boolean; ariaLabel?: string; className?: string;
}) {
  return (
    <button
      type="button"
      className={`rounded border border-border px-2 py-0.5 text-meta disabled:opacity-50 ${danger ? 'text-fg hover:text-danger' : 'text-fg hover:bg-surface-sunken'} ${pressed ? 'bg-surface-sunken' : ''} ${className}`}
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
/**
 * 에이전트가 만든 비밀의 배지(security L2). 지금 값을 에이전트가 정했으면 「값을 @x 가 정함」(경고 톤 — 그 에이전트는 값을
 * 안다), 사람이 값을 바꿨으면 「@x 가 만듦」만. 사람이 만든 비밀·옛 서버(칸 없음)는 아무것도 그리지 않는다.
 */
export function AgentMadeBadge({ secret }: { secret: Pick<SecretView, 'createdByAgentId' | 'valueSetByAgentId'> }) {
  const t = useT();
  const accounts = useActiveStore((s) => s.accounts);
  const handle = (id: string) => accounts[id]?.handle ?? id.slice(0, 8);
  if (secret.valueSetByAgentId) {
    const h = handle(secret.valueSetByAgentId);
    return (
      <span className="rounded bg-warning-surface px-1 text-warning" data-testid="secret-value-by-agent" title={t('secrets.valueByAgentTitle', { handle: h })}>
        {t('secrets.valueByAgent', { handle: h })}
      </span>
    );
  }
  if (secret.createdByAgentId) {
    return <span className="rounded border border-border px-1 text-fg-muted" data-testid="secret-by-agent">{t('secrets.byAgent', { handle: handle(secret.createdByAgentId) })}</span>;
  }
  return null;
}

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
  // 비밀은 **내 에이전트**에게만 준다 — 서버도 남의 에이전트는 not_own_agent 로 거절한다(#1135 security M1).
  const agents = Object.values(accounts).filter((a) => a.kind === 'agent').sort((a, b) => a.handle.localeCompare(b.handle));
  const mineAgents = agents.filter((a) => a.ownerAccountId === me?.id);
  const grantedIds = new Set(Array.isArray(rows) ? rows.map((g) => g.agentId) : []);

  return (
    <div className="mt-2" data-testid="secret-grants">
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
              {/* #1156 앞에 생긴 옛 줄: 받는 에이전트의 소유자가 비밀 주인과 다르면 서버가 reveal 을 not_own_agent 로 막는다. */}
              {accounts[g.agentId] && accounts[g.agentId]!.ownerAccountId !== secret.ownerAccountId && (
                <span className="rounded bg-danger-surface px-1 text-danger" data-testid={`secret-grant-not-own-${handle(g.agentId)}`}>{t('secrets.notOwnBlocked')}</span>
              )}
              <span className="ml-auto"><SmallButton onClick={() => setRevoking(g)} disabled={busy} danger ariaLabel={t('secrets.revokeAria', { handle: handle(g.agentId) })}>{t('secrets.revoke')}</SmallButton></span>
            </li>
          ))}
        </ul>
      )}
      {canGrant ? (
        <div className="mt-2">
          <SecretAgentPicker candidates={mineAgents} granted={grantedIds} disabled={busy}
            onPick={(id) => { setAgentId(id); setOperator('current'); setError(null); }} />
          {agentId && (
            <GrantConfirm
              secret={secret}
              agent={accounts[agentId]}
              handle={handle}
              operator={operator}
              onOperator={setOperator}
              busy={busy}
              onCancel={() => setAgentId('')}
              onGive={() => void run(async () => {
                await getController().putSecretGrant(secret.id, { agentId, channelId: null, operator });
                setAgentId('');
              })}
            />
          )}
        </div>
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
 * 에이전트를 고른 뒤의 **확인 줄**(designer 시안 v1 #1·#4). 고르기 전에는 경고가 없다 — 주황 큰 글이 늘 떠 있으면
 * 아무도 읽지 않는다. 고른 뒤 [주기] 바로 위에서 한 줄 회색으로 말하고 「모든 스레드」만 강조한다.
 * 어느 오퍼레이터든을 고르면 한 줄 덧붙인다. 에이전트가 값을 정한 비밀의 안내(`adoptNote`)·경고(`widenWarn`,
 * security L2)는 그대로 — 그 경고만 주황으로 남는다.
 */
function GrantConfirm({ secret, agent, handle, operator, onOperator, busy, onCancel, onGive }: {
  secret: SecretView; agent: AccountView | undefined; handle(id: string): string;
  operator: 'current' | 'any'; onOperator(v: 'current' | 'any'): void;
  busy: boolean; onCancel(): void; onGive(): void;
}) {
  const t = useT();
  const agentId = agent?.id ?? '';
  const h = agent?.handle ?? agentId.slice(0, 8);
  // 「모든 스레드」 강조: 문장을 자리표시로 쪼개 그 낱말만 굵게 — 번역마다 낱말 자리가 달라도 된다.
  const [before, after] = t('secrets.allChannelsNote', { handle: h, all: '\u0001' }).split('\u0001');
  const valueBy = secret.valueSetByAgentId;
  const radios = useRef<Partial<Record<'current' | 'any', HTMLButtonElement | null>>>({});
  // 고른 뒤 초점은 세그먼트의 골라진 칸으로(designer n1) — [주기] 로 보내면 Enter 한 번에 줘 버린다.
  useEffect(() => { radios.current[operator]?.focus(); }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="mt-2 rounded-card border border-border bg-surface-sunken px-3 py-2" data-testid="secret-grant-confirm">
      <div className="flex flex-wrap items-center gap-2 text-meta">
        <Identity account={agent} className="h-5 w-5 text-[10px]" variant="avatar" />
        <span className="font-medium text-fg">{t('secrets.grantTo', { handle: h })}</span>
        <div role="radiogroup" aria-label={t('secrets.grantOperator')} className="inline-flex gap-0.5 rounded-row bg-surface p-0.5"
          onKeyDown={(e) => {
            // 라디오 묶음은 ←→ 로 옮기고 Tab 한 번에 빠진다(designer n3) — 고른 칸만 tabIndex 0.
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            e.preventDefault();
            const next = operator === 'current' ? 'any' : 'current';
            onOperator(next);
            radios.current[next]?.focus();
          }}>
          {(['current', 'any'] as const).map((v) => (
            <button key={v} ref={(el) => { radios.current[v] = el; }} type="button" role="radio" aria-checked={operator === v} disabled={busy}
              tabIndex={operator === v ? 0 : -1}
              className={`rounded-row px-2.5 py-0.5 text-meta ${operator === v ? 'bg-surface-raised text-fg' : 'text-fg-muted hover:text-fg'}`}
              onClick={() => onOperator(v)}>
              {v === 'current' ? t('secrets.operatorCurrent') : t('secrets.operatorAny')}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 flex gap-1.5 text-meta text-fg-muted" data-testid="secret-grants-all-channels">
        <span aria-hidden="true">⚠</span>
        <span>{before}<strong className="font-medium text-warning">{t('secrets.allChannelsEmph')}</strong>{after}</span>
      </p>
      {operator === 'any' && (
        <p className="mt-1 flex gap-1.5 text-meta text-fg-muted" data-testid="secret-grant-any-warn">
          <span aria-hidden="true">⚠</span><span>{t('secrets.anyOperatorWarn')}</span>
        </p>
      )}
      {/* 에이전트가 값을 정한 비밀(security L2): 그 에이전트는 값을 안다 — 다른 에이전트에게 넓히기 전에 말한다. */}
      {valueBy && (
        <p className="mt-1 text-meta text-fg-subtle" data-testid="secret-adopt-note">{t('secrets.adoptNote', { handle: handle(valueBy) })}</p>
      )}
      {valueBy && agentId !== valueBy && (
        <p role="alert" className="mt-1 text-meta text-warning" data-testid="secret-widen-warn">{t('secrets.widenWarn', { handle: handle(valueBy) })}</p>
      )}
      {/* 경고를 다 읽은 뒤에 [주기] — 읽는 순서대로 버튼은 맨 끝(security #1266 n3). */}
      <div className="mt-2 flex justify-end gap-2" data-testid="secret-grant-actions">
        <SmallButton onClick={onCancel} disabled={busy}>{t('secrets.cancel')}</SmallButton>
        <button type="button" disabled={busy} onClick={onGive}
          className="rounded-row bg-accent px-2.5 py-0.5 text-meta font-medium text-fg-on-strong hover:bg-accent-hover disabled:opacity-50">
          {t('secrets.grant')}
        </button>
      </div>
    </div>
  );
}

/**
 * 접근 기록의 「결과」를 사람 말로(designer n2). 서버 코드를 그대로 두지 않는다 — `api:<연결> <METHOD> <경로>` 는 API 호출로
 * 키를 건넨 줄(P3)이고, 나머지 거절 이유는 아는 것만 옮기고 모르는 것은 코드 그대로 둔다.
 */
function accessText(t: ReturnType<typeof useT>, r: SecretAccessView): string {
  if (r.result === 'granted' && r.action) {
    return r.action === 'copy' ? t('secrets.accessCopied') : r.action === 'download' ? t('secrets.accessDownloaded') : t('secrets.accessViewed');
  }
  if (r.result === 'granted') {
    if (r.reason?.startsWith('api:')) return t('secrets.accessApi', { what: r.reason.slice(4) });
    return t('secrets.accessMounted');
  }
  const known: Record<string, string> = {
    not_granted: t('secrets.why.notGranted'), wrong_channel: t('secrets.why.wrongChannel'), wrong_operator: t('secrets.why.wrongOperator'),
    grant_suspended: t('secrets.why.suspended'), secret_expired: t('secrets.why.expired'), rate_limited: t('secrets.why.rateLimited'),
    lease_invalid: t('secrets.why.lease'), not_own_agent: t('secrets.why.notOwnAgent'), owner_inactive: t('secrets.why.ownerInactive'),
    step_up_required: t('secrets.why.stepUp'),
  };
  return t('secrets.accessDenied', { why: (r.reason && known[r.reason]) ?? r.reason ?? '?' });
}

/**
 * 같은 사람·같은 기기·같은 IP 의 **연달아 나온** 「막힘(잠금 해제 안 됨)」 줄을 한 줄로 접는다(designer, #1253 n1 뒤에도
 * 잠긴 채 두드리면 403 마다 한 줄이 남는다). 기록은 그대로이고 화면만 접는다. 목록은 최신이 위다.
 */
export type AccessRowView = SecretAccessView & { count: number; firstAt: string };
export function foldAccessRows(rows: SecretAccessView[]): AccessRowView[] {
  const out: AccessRowView[] = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    const foldable = r.result === 'denied' && r.reason === 'step_up_required' && !!r.actorAccountId;
    if (foldable && prev && prev.result === 'denied' && prev.reason === 'step_up_required'
      && prev.actorAccountId === r.actorAccountId && (prev.client ?? null) === (r.client ?? null)
      // client 는 앱의 자기 신고라, 검증된 단서인 ip 까지 같아야 접는다(security #1261 n5). 소유자 아니면 ip 는 둘 다 null.
      && (prev.ip ?? null) === (r.ip ?? null)) {
      prev.count += 1; prev.firstAt = r.at;
      continue;
    }
    out.push({ ...r, count: 1, firstAt: r.at });
  }
  return out;
}

function AccessPanel({ secret }: { secret: SecretView }) {
  const t = useT();
  const locale = useLocale();
  const accounts = useActiveStore((s) => s.accounts);
  const channels = useActiveStore((s) => s.channels);
  const meId = useActiveStore((s) => s.me?.id ?? null);
  const [rows, setRows] = useState<SecretAccessView[] | 'loading' | 'error'>('loading');
  /** 누가: 에이전트면 @handle, 사람(소유자 보기)이면 @handle (나). */
  const who = (r: SecretAccessView): string => {
    if (r.agentId) return `@${accounts[r.agentId]?.handle ?? r.agentId.slice(0, 8)}`;
    if (r.actorAccountId) {
      const h = `@${accounts[r.actorAccountId]?.handle ?? r.actorAccountId.slice(0, 8)}`;
      return r.actorAccountId === meId ? t('secrets.accessMe', { who: h }) : h;
    }
    return '—';
  };
  useEffect(() => {
    let live = true;
    getController().listSecretAccess(secret.id).then((r) => { if (live) setRows(r); }, () => { if (live) setRows('error'); });
    return () => { live = false; };
  }, [secret.id]);
  return (
    <div className="mt-2 overflow-x-auto" data-testid="secret-access">
      {rows === 'loading' && <p className="text-meta text-fg-muted">{t('secrets.loading')}</p>}
      {rows === 'error' && <p role="alert" className="text-meta text-danger">{t('secrets.listFailed')}</p>}
      {Array.isArray(rows) && rows.length === 0 && <p className="text-meta text-fg-subtle">{t('secrets.accessNone')}</p>}
      {Array.isArray(rows) && rows.length > 0 && (
        <table className="w-full text-left text-meta">
          <thead className="text-fg-subtle">
            <tr><th className="pr-3 font-medium">{t('secrets.accessAt')}</th><th className="pr-3 font-medium">{t('secrets.accessWho')}</th><th className="pr-3 font-medium">{t('secrets.accessWhere')}</th><th className="font-medium">{t('secrets.accessResult')}</th></tr>
          </thead>
          <tbody>
            {foldAccessRows(rows).map((r) => (
              <tr key={r.id} className="border-t border-border text-fg" data-testid={r.count > 1 ? 'secret-access-folded' : undefined}>
                <td className="pr-3">
                  {r.count > 1
                    ? `${new Date(r.firstAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}–${new Date(r.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`
                    : new Date(r.at).toLocaleString(locale)}
                </td>
                <td className="pr-3">{who(r)}</td>
                <td className="pr-3" title={r.ip ?? undefined}>{r.channelId ? `#${channels.find((c) => c.id === r.channelId)?.name ?? r.channelId.slice(0, 8)}` : (r.client ?? '—')}</td>
                <td>
                  {r.result === 'denied' && r.actorAccountId
                    ? <span className="rounded bg-warning-surface px-1 text-warning">{accessText(t, r)}{r.count > 1 ? ` ×${r.count}` : ''}</span>
                    : accessText(t, r)}
                  {r.version !== null ? ` · v${r.version}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-1 text-meta text-fg-subtle">{t('secrets.accessNote')}</p>
    </div>
  );
}
