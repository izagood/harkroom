import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import type { AccountView } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { StatusMark } from './Identity';
import { presenceView, PRESENCE_DOT_CLASS, PRESENCE_LABEL } from '../lib/presenceView';
import { useT } from '../i18n/useT';

/**
 * 계정 목록의 한 줄 — 연결 점 · 이름 · `@handle` · 종류 · admin · 상태 · 비활성.
 *
 * 원래 디렉터리 겹창(#226)의 줄이었다. 겹창은 지웠고(소유자 결정 2026-11-23), 줄은
 * **설정 › 멤버와 초대**(UX ⑥b-5)·역할 칸이 쓰므로 이 파일로 옮겼다. `data-testid` 의
 * `directory-*` 접두는 시험이 집는 이름이라 그대로 둔다.
 *
 * 보여 주는 것은 `AccountView` 가 주는 것뿐이다: handle, displayName, kind, isAdmin,
 * disabled, 상태. **harness·model·workingDir·소유자·PAT 는 그리지 않는다** — 그것들은
 * `GET /accounts/agents`(`requireAdmin`)의 것이다. `AgentView extends AccountView` 라서
 * harness 를 가진 객체가 이 자리에 그대로 들어올 수 있다 — 타입이 막아 주지 않으므로
 * 경계는 이 컴포넌트가 지킨다.
 */
export function AccountRow({ account: a, selected: isSelected = false, showKind = true, actions, detail, roleChip = false, onSelect }: {
  account: AccountView; selected?: boolean;
  /**
   * 역할 칩(owner·admin·member·guest)을 `admin` 표지 대신 단다 — 멤버와 초대가 「이 사람은 무엇을 할 수 있나」에
   * 목록에서 답하는 자리다(designer 시안 B). 다른 목록은 지금처럼 admin 만 표시한다.
   */
  roleChip?: boolean;
  /** 줄을 누르면 부른다(멤버와 초대: 오른쪽 칸이 그 사람의 역할·권한이 된다). 없으면 줄은 눌리지 않는다. */
  onSelect?(): void;
  /** 줄 끝에 붙는 동작(멤버와 초대의 「재설정 코드」 등). 없으면 아무것도 그리지 않는다. */
  actions?: ReactNode;
  /** `@handle` 바로 뒤에 붙는 「누구인가」 정보(멤버와 초대의 로그인 ID 등). 좁으면 이 칸이 먼저 줄어든다. */
  detail?: ReactNode;
  /** 종류 칩(`HUMAN`/`AGENT`). 사람만 싣는 목록(멤버와 초대)에서는 모든 줄에 같은 칩이 서서 소음이다. */
  showKind?: boolean;
}) {
  const t = useT();
  const online = useActiveStore((s) => s.online);
  // `#443`: presence 는 **서버가 주는 것**이라 소켓이 끊기면 낡는다. `online` 만 읽으면
  // 끊긴 뒤에도 마지막으로 들은 값이 지금 사실처럼 그려진다(실측 2026-09-06: 서버가 죽었는데
  // 에이전트 6개가 전부 초록이었다). `connected` 가 그 낡음을 아는 유일한 문지기다.
  const connected = useActiveStore((s) => s.connected);
  const presence = presenceView(a.id, online, connected);
  return (
    <li
      data-testid={`directory-row-${a.id}`}
      data-selected={String(isSelected)}
      // 강조만 하고 화면 밖에 두면 긴 목록에서는 아무 일도 안 일어난 것과 같다.
      // `scrollIntoView?.` 인 이유: jsdom 에는 그 함수가 없다 — 옵셔널 호출을 빼면 이
      // 화면을 띄우는 테스트가 렌더 도중 터진다(`MessageItem` 도 같은 이유로 그렇다).
      ref={isSelected ? (el: HTMLLIElement | null) => { el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); } : undefined}
      className={`flex items-center gap-2 rounded-row px-2 py-1.5 ${a.disabled ? 'opacity-60' : ''} ${isSelected ? 'bg-accent-surface ring-2 ring-accent' : ''} ${onSelect && !isSelected ? 'cursor-pointer hover:bg-surface-sunken' : onSelect ? 'cursor-pointer' : ''}`}
      {...(onSelect ? {
        role: 'button',
        tabIndex: 0,
        'aria-pressed': isSelected,
        onClick: (e: MouseEvent) => {
          // 줄 끝 동작(재설정 코드 등)을 누른 것은 줄을 고른 것이 아니다.
          if ((e.target as HTMLElement).closest('button, a, input')) return;
          onSelect();
        },
        onKeyDown: (e: KeyboardEvent) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
        },
      } : {})}
    >
    {/* 여기 있던 `Identity variant="badge"`(🤖 + 소유자 @핸들)를 뺐다 — 화면은 계정이
        사람인지 에이전트인지 말하지 않는다(design doc 2, #455). 소유자는 프로필(#475)이
        답한다. 사람 행에서는 애초에 아무것도 그리지 않던 자리라(#365), 지우고 나면
        두 종류의 행이 같은 모양으로 선다. */}
    {/* 연결 점은 소켓이 붙어 있는가다. 사람이 고른 상태(StatusMark)와 나란히 둔다 —
        합치면 "연결이 끊긴 사람"과 "방해 금지인 사람"이 한 표시로 뭉친다(#186).

        `#443`: 값이 **셋**이다. 앞 판본은 `online.includes()` 하나로 갈라 끊긴 동안에도
        낡은 배열이 초록을 그렸다. 색이 스크린리더에 아무 말도 안 하므로 `title` 로도
        같은 말을 낸다 — 이 이슈의 본질이 "화면이 사람에게 말하지 않는다"이고,
        점만 바꾸고 글자를 안 주면 그 절반이 남는다. */}
    <span
      data-testid={`directory-presence-${a.id}`}
      data-online={presence}
      title={t(PRESENCE_LABEL[presence])}
      className={`h-2 w-2 shrink-0 rounded-full ${PRESENCE_DOT_CLASS[presence]}`}
    />
    <span className="font-medium text-fg">{a.displayName}</span>
    <span className="text-fg-muted">@{a.handle}</span>
    {detail && <span className="flex min-w-0 items-baseline">{detail}</span>}
    {showKind && (
      <span
        data-testid={`directory-kind-${a.id}`}
        className="rounded-sm bg-surface-sunken px-1 text-meta uppercase tracking-wide text-fg-muted"
      >
        {a.kind}
      </span>
    )}
    {roleChip ? <RoleChip role={a.role} /> : a.isAdmin && (
      <span className="rounded-sm bg-warning-surface px-1 text-meta text-warning">{t('chat.adminBadge')}</span>
    )}
    <StatusMark account={a} />
    {a.statusText && <span className="truncate text-meta text-fg-subtle">{a.statusText}</span>}
    {/* 비활성 계정은 목록에 남기되 **꺼져 있다는 것이 보여야 한다.** 감추면 "이 사람이
        없다"와 "꺼져 있다"가 구분되지 않는다. 흐리게만 두는 것도 부족하다 — 대비를
        못 보는 사람에게는 아무 신호도 아니다. */}
    {a.disabled && (
      <span
        data-testid={`directory-disabled-${a.id}`}
        className="rounded-sm bg-surface-hover px-1 text-meta text-fg"
      >
        {t('common.disabled')}
      </span>
    )}
    {actions && <span className="ml-auto flex shrink-0 items-center gap-1">{actions}</span>}
  </li>
  );
}

/**
 * 역할 칩(designer 시안 B): owner 는 주황 테두리, admin 은 옅은 주황 면, member 는 회색 테두리, guest 는 점선.
 * 낱말은 화면 어디서나 영문 그대로다(`chat.adminBadge` 와 같다). 옛 서버라 `role` 이 없으면 그리지 않는다.
 */
export function RoleChip({ role }: { role: AccountView['role'] | undefined }) {
  if (!role) return null;
  const tone = {
    owner: 'border border-accent text-accent-text',
    admin: 'border border-transparent bg-accent-surface text-accent-text',
    member: 'border border-border-strong text-fg-muted',
    guest: 'border border-dotted border-border-strong text-fg-muted',
  }[role];
  return (
    <span data-testid="role-chip" data-role={role} className={`shrink-0 whitespace-nowrap rounded-full px-1.5 text-meta ${tone}`}>
      {role}
    </span>
  );
}
