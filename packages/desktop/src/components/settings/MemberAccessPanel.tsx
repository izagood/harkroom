import { useCallback, useEffect, useState } from 'react';
import type { AccountView, Capability, GrantRow, Role } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useT } from '../../i18n/useT';
import type { MessageKey } from '../../i18n';
import { errorText } from '../../lib/errorText';
import { ConfirmDialog } from '../ConfirmDialog';
import { RoleChip } from '../Directory';
import { Switch } from './primitives';

/**
 * 멤버와 초대 › **한 사람의 역할·권한 칸**(designer 시안 B, 스레드 d5e5c5d4).
 *
 * 화면은 서버 규칙을 **비추기만** 한다 — 판정은 서버(`grantRoutes.ts`)가 한다:
 *
 * | 보는 사람 | 역할 | 권한 스위치 |
 * |---|---|---|
 * | owner | owner 를 뺀 모든 사람의 admin/member/guest | member 의 넷 |
 * | admin | member↔guest 만(admin 줄은 잠금 — 「admin 임명·해제는 owner 만」) | member 의 넷 |
 * | member·guest | 읽기 전용 | 읽기 전용(남의 grant 는 서버가 안 보여 준다 — 자기 것만) |
 *
 * 권한은 **전역 grant 로 뜻이 있는 넷**만 그린다. `operator.register` 는 member 기본이라 잠긴 줄로 보인다.
 * `repo.merge`·`api.call`·`secret.create`·`tool.allow` 는 에이전트에게 주는 것이고, `member.reset_password` 는
 * 역할로만 갖는다 — 사람 칸에 그리지 않는다.
 */
export const MEMBER_CAPS: readonly { cap: Capability; label: MessageKey; hint?: MessageKey }[] = [
  { cap: 'agent.create', label: 'members.cap.agentCreate', hint: 'members.cap.agentCreateHint' },
  { cap: 'channel.create', label: 'members.cap.channelCreate' },
  { cap: 'team.create', label: 'members.cap.teamCreate' },
  { cap: 'member.invite', label: 'members.cap.invite', hint: 'members.cap.inviteHint' },
];

const ROLE_OPTIONS: readonly { role: Exclude<Role, 'owner'>; hint: MessageKey }[] = [
  { role: 'admin', hint: 'members.role.adminHint' },
  { role: 'member', hint: 'members.role.memberHint' },
  { role: 'guest', hint: 'members.role.guestHint' },
];

/** 이 사람이 이 사람의 역할을 무엇으로 바꿀 수 있나 — 서버 `PUT /accounts/:id/role` 의 규칙을 그대로. */
export function roleChoices(viewer: AccountView | null, target: AccountView): Set<Exclude<Role, 'owner'>> {
  const none = new Set<Exclude<Role, 'owner'>>();
  if (!viewer || target.role === 'owner' || viewer.id === target.id && viewer.role !== 'owner') return none;
  if (viewer.role === 'owner') return new Set(['admin', 'member', 'guest']);
  if (viewer.role === 'admin' && target.role !== 'admin') return new Set(['member', 'guest']);
  return none;
}

/** 전역 grant 를 줄 수 있나 — 서버는 admin 만 준다. 대상이 member 일 때만 뜻이 있다(admin 은 다 있고, guest 는 안 받는다). */
export function canEditCaps(viewer: AccountView | null, target: AccountView): boolean {
  return viewer?.isAdmin === true && target.role === 'member';
}

type GrantState = { kind: 'loading' } | { kind: 'ready'; caps: Set<Capability> } | { kind: 'hidden' } | { kind: 'error' };

export function MemberAccessPanel({ person, me, onBack, testId }: {
  person: AccountView; me: AccountView | null; onBack(): void; testId: string;
}) {
  const t = useT();
  const [grants, setGrants] = useState<GrantState>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmAdmin, setConfirmAdmin] = useState(false);
  // 남의 grant 는 admin 만 읽는다(서버 403) — 묻지도 않는다. 자기 것은 누구나 읽는다.
  const canRead = me?.isAdmin === true || me?.id === person.id;
  const needCaps = person.role === 'member';

  const reload = useCallback(async () => {
    if (!needCaps) return;
    if (!canRead) { setGrants({ kind: 'hidden' }); return; }
    try {
      const rows: GrantRow[] = await getController().listGrants(person.id);
      setGrants({ kind: 'ready', caps: new Set(rows.filter((r) => r.scope === '' && !r.suspendedAt).map((r) => r.capability)) });
    } catch { setGrants({ kind: 'error' }); }
  }, [person.id, needCaps, canRead]);

  useEffect(() => { setGrants({ kind: 'loading' }); setError(null); setConfirmAdmin(false); void reload(); }, [reload]);

  const choices = roleChoices(me, person);
  const capsEditable = canEditCaps(me, person);

  const changeRole = async (role: Exclude<Role, 'owner'>) => {
    setBusy('role');
    setError(null);
    // **guest 로 내리면 켜 둔 권한을 같이 거둔다**(designer #1615 검토 1). 서버 `PUT /role` 은 역할만 바꾸고
    // grant 는 남기며 `can()` 은 guest 의 grant 도 인정한다 — 안 거두면 「guest 는 권한을 받지 않는다」는 칸의 말이
    // 거짓이 되고, 내린 사람이 계속 에이전트를 만든다. 순서는 **거두기 먼저**다: 역할부터 바꾸면 그 사이 권한을
    // 든 guest 가 생긴다. 어디서든 실패하면 거둔 것을 되돌려 주고 역할은 그대로 둔다(실패 = 아무것도 안 바뀜).
    const revoked: Capability[] = [];
    try {
      if (role === 'guest' && person.role !== 'guest') {
        const rows = await getController().listGrants(person.id);
        const held = new Set(rows.filter((r) => r.scope === '').map((r) => r.capability));
        for (const { cap } of MEMBER_CAPS) {
          if (!held.has(cap)) continue;
          await getController().deleteGrant(person.id, cap, '');
          revoked.push(cap);
        }
      }
      await getController().setRole(person.id, role);
      // 디렉터리의 `role` 은 `grant.changed` 로도 다시 읽히지만, 소켓을 기다리지 않고 바로 맞춘다.
      await getController().refreshAccounts({ force: true }).catch(() => undefined);
      setConfirmAdmin(false);
    } catch (e) {
      const restored = await Promise.all(revoked.map((cap) =>
        getController().putGrant(person.id, { capability: cap, scope: '', expiresAt: null }).then(() => true, () => false)));
      setError(restored.every(Boolean)
        ? t('members.save.failed', { reason: errorText(e, t) })
        : t('members.save.failedPartial', { reason: errorText(e, t) }));
      void reload();
    } finally { setBusy(null); }
  };

  const toggleCap = async (cap: Capability, on: boolean) => {
    if (grants.kind !== 'ready') return;
    const prev = grants.caps;
    // 바로 그린다 — 실패하면 원래 값으로 돌리고 위에 알린다(시안 「저장 실패」).
    const next = new Set(prev);
    if (on) next.add(cap); else next.delete(cap);
    setGrants({ kind: 'ready', caps: next });
    setBusy(cap);
    setError(null);
    try {
      if (on) await getController().putGrant(person.id, { capability: cap, scope: '', expiresAt: null });
      else await getController().deleteGrant(person.id, cap, '');
    } catch (e) {
      setGrants({ kind: 'ready', caps: prev });
      setError(t('members.save.failed', { reason: errorText(e, t) }));
    } finally { setBusy(null); }
  };

  const roleNote = person.role === 'owner' ? null
    : me?.role === 'admin' && person.role === 'admin' ? t('members.role.ownerOnlyAdmin')
      : me?.role === 'admin' ? t('members.role.ownerOnlyPromote')
        : !me?.isAdmin ? t('members.role.readOnly') : null;

  return (
    <div data-testid={testId} className="divide-y divide-border">
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-meta font-medium text-fg-muted">{t('members.panel.title')}</span>
        <button type="button" onClick={onBack} className="rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:bg-surface-hover">
          {t('members.panel.back')}
        </button>
      </div>
      <div className="min-w-0 px-4 py-3">
        <div className="truncate font-medium text-fg">{person.displayName}</div>
        <div className="truncate text-meta text-fg-subtle">@{person.handle}</div>
      </div>
      {error && (
        <div className="px-4 py-2">
          <p role="alert" className="rounded-row border border-danger-border bg-danger-surface p-2 text-meta text-danger">{error}</p>
        </div>
      )}
      <fieldset className="px-4 py-3" disabled={busy !== null}>
        <legend className="float-left mb-1 w-full font-medium text-fg">{t('members.role.title')}</legend>
        {person.role === 'owner' ? (
          <div className="clear-left flex items-center gap-2">
            <RoleChip role="owner" />
            <span className="text-meta text-fg-subtle">{t('members.role.ownerFixed')}</span>
          </div>
        ) : (
          <div className="clear-left flex flex-col gap-1">
            {ROLE_OPTIONS.map(({ role, hint }) => {
              const enabled = choices.has(role);
              return (
                <label key={role} className={`flex items-start gap-2 py-0.5 ${enabled ? 'cursor-pointer' : 'opacity-50'}`}>
                  <input
                    type="radio"
                    name={`role-${testId}`}
                    data-testid={`${testId}-role-${role}`}
                    className="mt-1 accent-[var(--color-accent)]"
                    checked={person.role === role}
                    disabled={!enabled}
                    onChange={() => {
                      if (role === person.role) return;
                      // admin 은 전역 권한을 전부 받는다 — 승격만 한 번 더 묻는다. 내리기·member↔guest 는 되돌리기 쉽다.
                      if (role === 'admin') setConfirmAdmin(true);
                      else void changeRole(role);
                    }}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium text-fg">{role}</span>
                    <span className="block text-meta text-fg-subtle">{t(hint)}</span>
                  </span>
                </label>
              );
            })}
            {roleNote && <p className="mt-1 text-meta text-fg-subtle">{roleNote}</p>}
          </div>
        )}
      </fieldset>
      <div className="px-4 py-3" data-testid={`${testId}-caps`}>
        <div className="mb-1 font-medium text-fg">{t('members.cap.title')}</div>
        {person.role === 'owner' || person.role === 'admin' ? (
          <p className="text-meta text-fg-subtle">{t('members.cap.allByRole', { role: person.role })}</p>
        ) : person.role === 'guest' ? (
          <p className="text-meta text-fg-subtle">{t('members.cap.guestNone')}</p>
        ) : grants.kind === 'hidden' ? (
          <p className="text-meta text-fg-subtle">{t('members.cap.adminOnly')}</p>
        ) : grants.kind === 'error' ? (
          <p role="alert" className="text-meta text-danger">{t('members.cap.loadFailed')}</p>
        ) : grants.kind === 'loading' ? (
          <p className="text-meta text-fg-subtle">{t('directory.loading')}</p>
        ) : (
          <ul className="flex flex-col">
            {MEMBER_CAPS.map(({ cap, label, hint }) => (
              <li key={cap} className="flex items-center gap-3 py-1.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-fg">{t(label)}</span>
                  {hint && <span className="block text-meta text-fg-subtle">{t(hint)}</span>}
                </span>
                <Switch
                  testId={`${testId}-cap-${cap}`}
                  ariaLabel={t(label)}
                  checked={grants.caps.has(cap)}
                  disabled={!capsEditable || busy !== null}
                  onChange={(on) => void toggleCap(cap, on)}
                />
              </li>
            ))}
            <li className="flex items-center gap-3 py-1.5 opacity-60">
              <span className="min-w-0 flex-1">
                <span className="block text-fg">{t('members.cap.operatorRegister')}</span>
                <span className="block text-meta text-fg-subtle">{t('members.cap.memberDefault')}</span>
              </span>
              <Switch ariaLabel={t('members.cap.operatorRegister')} checked disabled onChange={() => {}} />
            </li>
          </ul>
        )}
      </div>
      {confirmAdmin && (
        <ConfirmDialog
          title={t('members.promote.title', { handle: person.handle })}
          detailKind="note"
          detail={(
            <>
              <span className="block">{t('members.promote.body')}</span>
              <span className="mt-2 block">{t('members.promote.memberInstead')}</span>
            </>
          )}
          confirmLabel={t('members.promote.confirm')}
          cancelLabel={t('members.promote.cancel')}
          busy={busy === 'role'}
          error={error}
          onConfirm={() => void changeRole('admin')}
          onCancel={() => { setConfirmAdmin(false); setError(null); }}
        />
      )}
    </div>
  );
}
