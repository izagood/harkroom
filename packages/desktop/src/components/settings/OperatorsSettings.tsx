import { useCallback, useEffect, useState } from 'react';
import type { OperatorCapabilities, OperatorView } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { useAgo, useLocale, useT } from '../../i18n/useT';
import { dateTimeText } from '../../lib/localeText';
import { ConfirmDialog } from '../ConfirmDialog';
import { hasCapability } from '../../lib/capabilities';
import { hasOperatorLocalSurface } from '../../lib/operatorLocal';
import { SettingsColumns, SettingsGrid, SettingsGroup, SettingsPage } from './primitives';
import { OPERATOR_LABEL_MAX, operatorDisplayName, operatorFullName } from '../../lib/operatorName';
import { normalizeOperatorLabel } from '@harkroom/shared';

/**
 * 설정 › Operators — 스펙 2026-09-20 §3.
 *
 * 앱은 러너를 띄우지 않는다. 러너를 띄우는 것은 어느 머신에 상주하는 **오퍼레이터**이고,
 * 사람이 앱에서 하는 일은 그것을 **등록**(1회용 코드 → 그 머신의 `harkroom-operator
 * register`)하고, 등록된 것을 보고, 더 안 쓰는 것을 폐기하는 것뿐이다. 에이전트를 어느
 * 오퍼레이터에서 돌릴지는 에이전트 상세의 배정이 정한다 — 이 화면은 그 목록의 출처다.
 *
 * ## 코드는 한 번만 보인다
 *
 * 등록 코드는 서버가 메모리에만 5분 들고 있고 한 번 쓰면 사라진다. 그래서 초대 토큰과
 * 같은 규율로 그린다(`InviteSettings`): 지금 안 옮기면 다시 못 본다는 말을 코드 옆에 둔다.
 */
export function OperatorsSettings({ onOpenSection }: {
  /** 이 머신 등록 자리(이 기기 › 이 머신의 오퍼레이터)로 간다(UX ⑥b-2 후속). 없으면 글로만 안내한다. */
  onOpenSection?: (id: import('./sections').SectionId) => void;
} = {}) {
  const t = useT();
  const locale = useLocale();
  const me = useActiveStore((s) => s.me);
  const canRegister = hasCapability(me, 'operator.register');
  const [operators, setOperators] = useState<OperatorView[] | 'error' | null>(null);
  /** 오퍼레이터별 능력(스펙 §3). 붙어 있는 것만 읽는다 — 서버가 저장하지 않으므로 끊긴 것은 "모른다". */
  const [caps, setCaps] = useState<Record<string, OperatorCapabilities>>({});
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 이 머신에 오퍼레이터가 있는 빌드(Tauri)인가 — 있으면 코드를 사람이 옮길 필요가 없다. */
  const localAvailable = hasOperatorLocalSurface();
  const reload = useCallback(() => {
    void getController().operators().then((list) => {
      setOperators(list);
      for (const op of list) {
        if (!op.online) continue;
        void getController().operatorCapabilities(op.id)
          .then((c) => setCaps((prev) => ({ ...prev, [op.id]: c })))
          // 읽는 사이에 끊겼을 수 있다 — 능력 줄 하나가 비는 것이지 목록의 실패가 아니다.
          .catch(() => undefined);
      }
    }).catch(() => setOperators('error'));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const issue = async () => {
    setError(null);
    setBusy(true);
    try {
      setCode(await getController().operatorRegisterCode());
    } catch (e) {
      setError(e instanceof Error ? e.message : t('operators.registerFailed'));
    } finally {
      setBusy(false);
    }
  };

  /** 지우기 전에 한 번 묻는다(UX ④c) — `McpServersSettings` 와 같은 모양이다. */
  const [confirming, setConfirming] = useState<OperatorView | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const revoke = async (op: OperatorView) => {
    setRevokeError(null);
    setRevoking(true);
    try {
      await getController().revokeOperator(op.id);
      setConfirming(null);
      reload();
    } catch (e) {
      setRevokeError(e instanceof Error ? e.message : t('operators.revokeFailed'));
    } finally {
      setRevoking(false);
    }
  };
  const ago = useAgo();

  /**
   * 이름 바꾸기(스레드 e12e6780, designer 시안) — 이름 옆 연필이나 이름 글자를 누르면 그 자리가 입력칸이
   * 된다. Enter·칸 밖 = 저장, Esc = 취소. 편집 중에는 Delete 자리에 Cancel·Save 가 선다(잘못 누르지 않게).
   * 비우고 저장하면 호스트명으로 돌아간다. 같은 이름은 경고만 하고 막지 않는다(배정은 id 로 고른다).
   * 권한은 Delete 와 같다 — 이 목록은 서버가 "소유자 또는 operator.manage" 로 이미 걸렀다.
   */
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const startRename = (op: OperatorView) => { setRenameError(null); setEditing({ id: op.id, draft: operatorDisplayName(op) }); };
  const cancelRename = () => { setEditing(null); setRenameError(null); };
  const saveRename = async (op: OperatorView, raw: string) => {
    if (savingName) return;
    // 서버와 같은 정리를 먼저 한다 — 그래야 "바뀐 것 없음" 판정이 서버가 저장할 값과 맞는다.
    const tidy = normalizeOperatorLabel(raw);
    const label = tidy && tidy !== op.name ? tidy : null;
    // 바뀐 것이 없으면 요청 없이 닫는다 — 칸 밖을 누를 때마다 감사가 쌓이지 않게.
    if (label === (op.label ?? null)) { cancelRename(); return; }
    setSavingName(true);
    setRenameError(null);
    try {
      const updated = await getController().renameOperator(op.id, label);
      // 응답을 그대로 앉힌다(online 은 목록을 읽은 때의 값을 지킨다) — 다시 읽지 않아도 새 이름이 선다.
      setOperators((prev) => (Array.isArray(prev)
        ? prev.map((x) => (x.id === op.id ? { ...x, ...updated, label: updated.label ?? null, online: x.online } : x))
        : prev));
      setEditing(null);
    } catch (e) {
      // 입력은 그대로 둔다 — 실패했다고 사람이 친 글자를 버리지 않는다.
      setRenameError(t('operators.renameFailed', { reason: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSavingName(false);
    }
  };

  return (
    <SettingsPage section="operators" description={t('operators.description')} layout="list">
      {/* 오퍼레이터 하나가 카드 하나 — 넓은 창에서 2·3단 격자로 선다(시안 v1 list). 등록은 곁 칸. */}
      <SettingsColumns
        testId="operators-columns"
        main={(
      <SettingsGrid testId="operators-grid">
        {operators === null && <p className="rounded-compose border border-border bg-surface-raised px-4 py-3 text-meta text-fg-muted">{t('operators.loading')}</p>}
        {operators === 'error' && <p role="alert" className="rounded-compose border border-border bg-surface-raised px-4 py-3 text-meta text-danger">{t('operators.listFailed')}</p>}
        {Array.isArray(operators) && operators.length === 0 && (
          <p className="rounded-compose border border-border bg-surface-raised px-4 py-3 text-meta text-fg-subtle">{t('operators.none')}</p>
        )}
        {Array.isArray(operators) && operators.map((op) => (
          <div key={op.id} className="flex items-center justify-between gap-4 rounded-compose border border-border bg-surface-raised px-4 py-3">
            <span className="min-w-0 flex-1">
              {editing?.id === op.id ? (
                <span className="block">
                  <input
                    autoFocus
                    data-testid={`operator-name-input-${op.id}`}
                    aria-label={t('operators.nameLabel')}
                    aria-invalid={renameError ? true : undefined}
                    className="w-full max-w-sm rounded-row border border-accent bg-surface px-2 py-1 font-medium text-fg"
                    maxLength={OPERATOR_LABEL_MAX}
                    value={editing.draft}
                    disabled={savingName}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => { setRenameError(null); setEditing({ id: op.id, draft: e.target.value }); }}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing) return; // 한글 조합 중 Enter 는 글자 확정이다
                      if (e.key === 'Enter') { e.preventDefault(); void saveRename(op, editing.draft); }
                      if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                    }}
                    // 실패한 뒤의 blur 는 다시 저장하지 않는다 — 빨간 줄을 읽는 사이 같은 요청이 되풀이된다.
                    onBlur={() => { if (!renameError) void saveRename(op, editing.draft); }}
                  />
                  {(() => {
                    const shown = normalizeOperatorLabel(editing.draft) ?? '';
                    const dup = shown !== '' && operators.some((o) => o.id !== op.id && operatorDisplayName(o) === shown);
                    return dup ? <span className="mt-1 block text-meta text-warning" data-testid={`operator-name-dup-${op.id}`}>{t('operators.duplicateName')}</span> : null;
                  })()}
                  {op.label && (
                    <button
                      type="button"
                      data-testid={`operator-use-hostname-${op.id}`}
                      className="mt-1 block text-meta text-fg-muted hover:underline"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void saveRename(op, '')}
                    >
                      {t('operators.useHostname', { name: op.name })}
                    </button>
                  )}
                  {renameError && <span role="alert" className="mt-1 block text-meta text-danger">{renameError}</span>}
                </span>
              ) : (
                <span className="group flex min-w-0 items-center gap-1">
                  <button
                    type="button"
                    data-testid={`operator-name-${op.id}`}
                    // 키보드는 연필에서만 멈춘다 — 같은 일을 하는 버튼 둘에 Tab 이 두 번 서지 않게(마우스로는 이름도 눌린다).
                    tabIndex={-1}
                    className="min-w-0 truncate text-left font-medium text-fg"
                    onClick={() => startRename(op)}
                  >
                    {operatorDisplayName(op)}
                  </button>
                  <button
                    type="button"
                    aria-label={t('operators.renameAction', { name: operatorDisplayName(op) })}
                    title={t('operators.renameAction', { name: operatorDisplayName(op) })}
                    className="shrink-0 rounded-row p-0.5 text-fg-subtle opacity-60 hover:bg-surface-sunken hover:opacity-100"
                    onClick={() => startRename(op)}
                  >
                    <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11.5 2.5l2 2L6 12H4v-2z" />
                    </svg>
                  </button>
                </span>
              )}
              <span className="mt-0.5 block text-meta text-fg-subtle" data-testid={`operator-online-${op.id}`}>
                {/* 이름을 바꾼 줄만 원래 호스트명을 앞에 둔다(designer) — 안 바꾼 줄은 이름이 곧 호스트명이다. */}
                {op.label && (
                  <span className="font-mono" title={t('operators.hostname')} data-testid={`operator-hostname-${op.id}`}>{`${op.name} · `}</span>
                )}
                {/* 연결은 **지금의 사실**이다(허브가 든다) — 저장된 값이 아니라 목록을 읽은
                    순간의 값이고, 끊긴 오퍼레이터의 배정은 서버가 오프라인으로 그린다. */}
                <span className={`mr-1 inline-block h-2 w-2 rounded-full ${op.online ? 'bg-success' : 'bg-fg-subtle'}`} />
                {op.online ? t('operators.online') : t('operators.offline')}
                {/* 상대 시각으로(UX ④c) — 초까지 찍은 절대 시각은 읽기 느리다. 전체 시각은 `title` 에. */}
                {op.lastSeenAt && !op.online && (
                  <span title={dateTimeText(op.lastSeenAt, locale)}>
                    {` · ${t('operators.lastSeen', { at: ago(new Date(op.lastSeenAt).getTime()) })}`}
                  </span>
                )}
              </span>
              {/* 능력(스펙 §3): 이 머신이 돌릴 수 있는 에이전트 수와 하네스. 배정이 409 로 거절되는
                  두 이유(로컬 설정에 없다·하네스가 없다)를 사람이 여기서 미리 본다. */}
              {caps[op.id] && (
                // 항목 단위로만 접는다 — 「로그인 안 / 됨」처럼 낱말 가운데서 줄이 바뀌지 않게.
                <span className="mt-0.5 flex flex-wrap gap-x-2 text-meta text-fg-subtle" data-testid={`operator-caps-${op.id}`}>
                  <span className="whitespace-nowrap">{t('operators.capsAgents', { count: caps[op.id]!.agentIds.length })}</span>
                  {Object.entries(caps[op.id]!.harnesses).map(([name, h]) => (
                    <span key={name} className="whitespace-nowrap">
                      {name}: {h.installed ? (h.loggedIn ? t('operators.harnessReady') : t('operators.harnessNotLoggedIn')) : t('operators.harnessMissing')}
                    </span>
                  ))}
                </span>
              )}
            </span>
            {/* 오른쪽 칸은 취소·저장 폭을 늘 비워 둔다 — 편집에 들어갈 때 왼쪽 글이 좁아져 다시 접히지 않게. */}
            <span className="flex min-w-[7.5rem] shrink-0 justify-end gap-2">
            {editing?.id === op.id ? (
              <>
                {/* mousedown 을 막아 입력칸이 blur(=저장)되기 전에 이 버튼이 눌리게 한다. */}
                <button
                  type="button"
                  className="rounded-row border border-border px-2 py-1 text-meta text-fg hover:bg-surface-sunken"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={cancelRename}
                >
                  {t('operators.cancel')}
                </button>
                <button
                  type="button"
                  className="rounded-row bg-accent px-2 py-1 text-meta font-medium text-fg-on-strong disabled:opacity-50"
                  disabled={savingName}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void saveRename(op, editing.draft)}
                >
                  {t('operators.save')}
                </button>
              </>
            ) : (
              <button
                className="shrink-0 rounded-row border border-border px-2 py-1 text-meta text-fg hover:bg-surface-sunken"
                aria-label={t('operators.revokeAction', { name: operatorFullName(op) })}
                onClick={() => { setRevokeError(null); setConfirming(op); }}
              >
                {t('operators.revoke')}
              </button>
            )}
            </span>
          </div>
        ))}
      </SettingsGrid>
        )}
        /* 곁 칸은 할 것이 있을 때만 세운다 — 등록 권한이 없으면 빈 380px 칸이 오른쪽에 남는다(격자가 그 폭을 쓴다). */
        side={canRegister || error ? (
          <>

      {error && (
        <div className="mb-4 rounded-row border border-danger-border bg-danger-surface p-3">
          <p role="alert" className="text-meta text-danger">{error}</p>
        </div>
      )}

      {canRegister && (
        <SettingsGroup>
          <div className="px-4 py-3">
            <p className="mb-3 text-meta text-fg-muted">{t(localAvailable ? 'operators.registerElsewhereNote' : 'operators.registerNote')}</p>
            {localAvailable && onOpenSection && (
              <button
                data-testid="operators-open-this-operator"
                className="mb-3 rounded-row px-2 py-1 text-meta text-accent hover:bg-surface-sunken"
                onClick={() => onOpenSection('this-operator')}
              >
                {t('operators.openThisOperator')}
              </button>
            )}
            {code && (
              <div className="mb-3 rounded-row border border-warning-border bg-warning-surface p-3">
                <div className="font-semibold text-warning">{t('operators.codeWarning')}</div>
                <code className="mt-1 block break-all rounded-row bg-surface-raised p-2 text-meta">{code.code}</code>
                {/* 다음에 할 일이 화면에 있어야 한다 — 코드만 주고 어디에 넣는지 말하지 않으면
                    사람은 문서를 찾으러 간다. 명령은 셸에 그대로 들어가는 값이라 번역하지 않는다. */}
                <pre
                  data-testid="operator-register-command"
                  className="mt-2 overflow-x-auto rounded-row bg-surface-raised p-2 font-mono text-meta text-fg"
                >
                  {`harkroom-operator register ${getController().api?.baseUrl ?? '<server>'} ${code.code}`}
                </pre>
                <div className="mt-2 text-meta text-warning">{t('operators.codeNextStep')}</div>
              </div>
            )}
            <button
              className="rounded-row bg-accent px-4 py-2 font-medium text-fg-on-strong disabled:opacity-50"
              disabled={busy}
              onClick={() => void issue()}
            >
              {busy ? t('operators.registerBusy') : code ? t('operators.registerAgain') : t('operators.register')}
            </button>
          </div>
        </SettingsGroup>
      )}
          </>
        ) : undefined}
      />
      {confirming && (
        <ConfirmDialog
          title={t('operators.confirmTitle', { name: operatorFullName(confirming) })}
          detail={t('operators.confirmDetail')}
          confirmLabel={t('operators.revoke')}
          cancelLabel={t('operators.cancel')}
          detailKind="note"
          danger
          busy={revoking}
          error={revokeError}
          onConfirm={() => void revoke(confirming)}
          onCancel={() => { setConfirming(null); setRevokeError(null); }}
        />
      )}
    </SettingsPage>
  );
}
