import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AgentTeamRow, HandleGroupRow } from '@harkroom/shared';
import { useT } from '../i18n/useT';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { Identity } from './Identity';
import { useHostDocument, useHostView } from '../lib/hostDocument';

/**
 * 여럿을 부르는 멘션(`@팀`·`@집합`)에 마우스를 올리면 **누구를 부르는지** 보여 준다.
 *
 * 칩만으로는 `@ops-team` 이 몇 명인지, 누가 팀장인지, 그중 누가 비활성이라 안 깨는지를
 * 알 수 없다. 그걸 모르면 "1명을 불렀는데 0명만 깼다"(`NotifiedGapRow`) 같은 줄을 읽고도
 * 누가 빠졌는지 설정 화면까지 가야 안다. 카드는 그 한 걸음을 없앤다.
 *
 * ## 명단은 열 때 받는다
 *
 * 스토어의 `teams`·`groups` 는 이름과 규모뿐이다(`appStore.ts` 의 `teams` 주석). 명단은
 * `GET /teams/:id`(모든 계정) · `GET /handle-groups/:id`(`channel.manage`) 에만 있다.
 * 캐시하지 않는 이유: 팀원·팀장은 설정에서 바뀌는데, 캐시를 두면 그 무효화를 한 곳 더
 * 맞춰야 하고 틀리면 카드가 옛 명단을 사실처럼 말한다. 호버 한 번에 요청 하나는 싸다.
 *
 * 집합 명단 요청이 403 이면 **규모만** 말하고 이유를 적는다 — 못 받은 명단을 "없다"로
 * 그리지 않는다(`docs/design.md` §4).
 */
export type MentionCardTarget =
  | { kind: 'team'; team: AgentTeamRow }
  | { kind: 'group'; group: HandleGroupRow };

interface Member {
  accountId: string;
  handle: string;
  disabled: boolean;
}

type Roster =
  | { state: 'loading' }
  | { state: 'ok'; members: Member[]; leadAccountId: string | null }
  | { state: 'denied' }
  | { state: 'failed' };

/** 올린 뒤 이만큼 머물러야 연다 — 본문을 가로지르는 마우스마다 요청이 나가지 않게. */
const OPEN_DELAY_MS = 300;
/** 칩에서 카드로 옮겨 가는 사이 닫히지 않게 주는 틈. */
const CLOSE_DELAY_MS = 150;
const CARD_WIDTH = 256;
const CARD_MAX_HEIGHT = 320;
const EDGE_GAP = 8;

export function MentionCard({ target, children }: { target: MentionCardTarget; children: ReactNode }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  // 카드는 칩이 그려진 **그 창**의 body 에 띄운다 — 메인 `document.body` 에 띄우면 새 창에서 연 카드가
  // 메인 창에 뜬다(좌표는 새 창 것이라 엉뚱한 자리다). 2026-10-06 F1.
  const hostDoc = useHostDocument();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const openSoon = () => {
    clear();
    timer.current = setTimeout(() => {
      if (wrapRef.current) setAnchor(wrapRef.current.getBoundingClientRect());
    }, OPEN_DELAY_MS);
  };
  const closeSoon = () => {
    clear();
    timer.current = setTimeout(() => setAnchor(null), CLOSE_DELAY_MS);
  };
  useEffect(() => clear, []);

  return (
    <span
      ref={wrapRef}
      data-testid="hovercard-trigger"
      onMouseEnter={openSoon}
      onMouseLeave={closeSoon}
      onFocus={openSoon}
      onBlur={closeSoon}
    >
      {children}
      {anchor &&
        createPortal(
          <CardBody target={target} anchor={anchor} onEnter={clear} onLeave={closeSoon} />,
          hostDoc.body,
        )}
    </span>
  );
}

function CardBody({
  target, anchor, onEnter, onLeave,
}: { target: MentionCardTarget; anchor: DOMRect; onEnter: () => void; onLeave: () => void }) {
  const t = useT();
  const view = useHostView();
  const accounts = useActiveStore((s) => s.accounts);
  const [roster, setRoster] = useState<Roster>({ state: 'loading' });
  const id = target.kind === 'team' ? target.team.id : target.group.id;

  useEffect(() => {
    let live = true;
    setRoster({ state: 'loading' });
    const load = target.kind === 'team'
      ? getController().getTeam(id).then(({ team, members }) => ({
          members: members.map((m) => ({ accountId: m.accountId, handle: m.handle, disabled: m.disabled })),
          leadAccountId: team.leadAccountId,
        }))
      : getController().getHandleGroup(id).then(({ members }) => ({
          // 집합 응답은 id 만 준다 — 이름은 이미 받은 계정 목록에서 찾는다.
          members: members.map((accountId) => {
            const a = useActiveStore.getState().accounts[accountId];
            return { accountId, handle: a?.handle ?? t('mention.unknownAccount'), disabled: a?.disabled === true };
          }),
          leadAccountId: null,
        }));
    load
      .then((r) => { if (live) setRoster({ state: 'ok', ...r }); })
      .catch((e: unknown) => {
        if (!live) return;
        const status = (e as { status?: number } | null)?.status;
        setRoster({ state: status === 403 ? 'denied' : 'failed' });
      });
    return () => { live = false; };
  }, [id, target.kind, t]);

  // 아래에 자리가 없으면 위로 연다. 가로는 창 안으로 민다(`Menu` 의 `openAt` 과 같은 계산).
  // 창은 카드가 그려지는 창이다(`useHostView`) — 새 창이면 그 창의 크기.
  const below = anchor.bottom + 4 + CARD_MAX_HEIGHT <= view.innerHeight - EDGE_GAP;
  const left = Math.max(EDGE_GAP, Math.min(anchor.left, view.innerWidth - CARD_WIDTH - EDGE_GAP));
  const style = below
    ? { position: 'fixed' as const, left, top: anchor.bottom + 4, width: CARD_WIDTH }
    : { position: 'fixed' as const, left, bottom: view.innerHeight - anchor.top + 4, width: CARD_WIDTH };

  const name = target.kind === 'team' ? target.team.name : target.group.handle;
  const count = target.kind === 'team' ? target.team.memberCount : target.group.memberCount;
  const kindLabel = target.kind === 'team' ? t('mention.card.team') : t('mention.card.group');

  // 팀장을 맨 위에 둔다 — 카드를 여는 가장 흔한 이유가 "누가 받나" 다.
  const members = roster.state === 'ok'
    ? [...roster.members].sort((a, b) =>
        Number(b.accountId === roster.leadAccountId) - Number(a.accountId === roster.leadAccountId))
    : [];

  return (
    <div
      role="tooltip"
      data-testid="hovercard"
      data-kind={target.kind}
      style={style}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="z-50 overflow-y-auto rounded-card bg-surface-raised p-3 text-body shadow-float"
    >
      <div className="font-semibold text-fg">@{name}</div>
      <div className="mt-0.5 text-meta text-fg-muted">
        {kindLabel} · {t('mention.card.members', { count })}
        {target.kind === 'group' && target.group.displayName ? ` · ${target.group.displayName}` : ''}
      </div>
      <div className="mt-2 border-t border-border pt-2" style={{ maxHeight: CARD_MAX_HEIGHT - 80 }}>
        {roster.state === 'loading' && <div className="text-meta text-fg-subtle">{t('mention.card.loading')}</div>}
        {roster.state === 'failed' && <div className="text-meta text-fg-subtle">{t('mention.card.failed')}</div>}
        {roster.state === 'denied' && <div className="text-meta text-fg-subtle">{t('mention.card.denied')}</div>}
        {roster.state === 'ok' && members.length === 0 && (
          <div className="text-meta text-fg-subtle">{t('mention.card.empty')}</div>
        )}
        {roster.state === 'ok' && members.length > 0 && (
          <ul className="space-y-1">
            {members.map((m) => {
              const isLead = m.accountId === roster.leadAccountId;
              const account = accounts[m.accountId];
              return (
                <li
                  key={m.accountId}
                  data-testid={`hovercard-member-${m.handle}`}
                  data-lead={String(isLead)}
                  data-disabled={String(m.disabled)}
                  className="flex items-center gap-2"
                >
                  {account && <Identity account={account} variant="avatar" />}
                  <span className={m.disabled ? 'text-fg-subtle line-through' : 'text-fg'}>@{m.handle}</span>
                  {isLead && (
                    <span className="rounded-sm bg-surface-sunken px-1 text-meta font-medium text-fg">
                      {t('mention.card.lead')}
                    </span>
                  )}
                  {m.disabled && <span className="text-meta text-fg-subtle">{t('mention.card.disabled')}</span>}
                </li>
              );
            })}
          </ul>
        )}
        {target.kind === 'team' && roster.state === 'ok' && roster.leadAccountId === null && members.length > 0 && (
          <div className="mt-2 text-meta text-fg-subtle">{t('mention.card.noLead')}</div>
        )}
      </div>
    </div>
  );
}
