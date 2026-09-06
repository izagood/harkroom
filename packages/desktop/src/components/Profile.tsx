import { useEffect, useState } from 'react';
import type { AgentView } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { Identity, StatusMark } from './Identity';
import { Overlay } from './Overlay';
import { lastTurnLabel } from './settings/AgentsSettings';
import type { SectionId } from './settings/sections';

/**
 * 프로필 — **알아야 할 때 여는 자리**(identity 문서 · Task 14).
 *
 * 지금까지 이름을 누르면 디렉터리(검색 목록)가 열렸다. 그것은 프로필이 아니다 —
 * `Directory.tsx` 주석이 "harness·소유자·PAT 는 그리지 않는다"고 적어 두었고, Task 12 가
 * 흐름에서 🤖 를 뺀 뒤로는 **그 정보가 어디에도 없었다.** 문서가 "흐름에서 표시를 빼면 그
 * 정보가 어디에도 없게 된다"고 경계한 그 자리다.
 *
 * ## 사람과 에이전트가 같은 틀을 쓴다
 *
 * 행 이름만 다르다 — 원칙 01("대화에서는 에이전트라고 말하지 않는다")의 연장이다. 종류는
 * 여기 와서야 나오고, 그때도 **다른 화면이 아니라 다른 행**으로 나온다.
 *
 * ## 볼 수 있는 것만 보여 준다
 *
 * harness·model·작업 디렉터리는 **admin·소유자만** 서버에서 받는다(`GET /accounts/agents` 가
 * 비admin 에게 자기 것만 준다). 남의 에이전트를 열면 그 행은 **아예 없다** — 비어 있는 행을
 * 그리면 "값이 없다"로 읽히는데 실제로는 "내가 못 본다"라서 거짓말이 된다(규칙 06).
 */
export function Profile({ accountId, onClose, onOpenSettings }: {
  accountId: string;
  onClose: () => void;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
}) {
  const account = useActiveStore((s) => s.accounts[accountId]);
  const me = useActiveStore((s) => s.me);
  const accounts = useActiveStore((s) => s.accounts);
  const online = useActiveStore((s) => s.online);
  const connected = useActiveStore((s) => s.connected);

  /** 설정까지 볼 수 있는가 — 서버의 판정과 같아야 한다(`GET /accounts/agents`). */
  const isOwner = account?.kind === 'agent'
    && account.ownerAccountId !== null && account.ownerAccountId === me?.id;
  const canSeeConfig = account?.kind === 'agent' && (me?.isAdmin === true || isOwner);

  const [agent, setAgent] = useState<AgentView | null>(null);
  useEffect(() => {
    if (!canSeeConfig) return;
    // 목록에서 고른다 — 이 라우트가 이미 권한 필터를 걸어 주므로 화면이 다시 거르지 않는다.
    void getController().listAgents()
      .then((list) => setAgent(list.find((a) => a.id === accountId) ?? null))
      .catch(() => setAgent(null));
  }, [accountId, canSeeConfig]);

  if (!account) return null;

  const owner = account.ownerAccountId ? accounts[account.ownerAccountId] : undefined;
  // 생존은 `threadState`·`waitChain` 과 같은 규약이다 — `connected` 가 false 면 '모른다'.
  const live = connected ? online.includes(account.id) : null;

  return (
    <Overlay label={`${account.handle} 프로필`} onClose={onClose} className="w-[26rem]">
      <div className="flex items-center gap-3 border-b border-border p-4">
        <Identity account={account} className="h-12 w-12 text-base" variant="avatar" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-semibold">{account.displayName || account.handle}</span>
            <StatusMark account={account} />
          </div>
          <div className="text-xs text-fg-muted">@{account.handle}</div>
        </div>
      </div>

      <div className="overflow-y-auto p-4">
        <dl className="space-y-2">
          {/* 종류는 여기 와서야 나온다 — 흐름에서는 말하지 않는다(원칙 01). */}
          <Row label="종류" value={account.kind === 'agent' ? '에이전트' : '사람'} />
          {account.isAdmin && <Row label="권한" value="admin" />}
          {account.disabled && <Row label="상태" value="비활성" />}

          {account.kind === 'agent' && (
            <Row
              label="연결"
              value={live === null ? '알 수 없음' : live ? '온라인' : '응답 없음'}
            />
          )}
          {/* 소유자가 `null` 인 것은 '아무나'가 아니라 '아직 아무도'다(#181) — 없으면 행이 없다. */}
          {owner && <Row label="소유자" value={`@${owner.handle}`} />}

          {canSeeConfig && agent && (
            <>
              <Row label="하네스" value={agent.harness} />
              <Row label="모델" value={agent.model ?? '하네스 기본값'} />
              <Row label="작업 디렉터리" value={agent.workingDir ?? '스레드마다 새로 만든다'} mono />
              <Row label="마지막 활동" value={lastTurnLabel(agent.lastTurnAt)} />
            </>
          )}
        </dl>

        <div className="mt-4 flex flex-wrap gap-2">
          {/*
            터미널은 **소유자·admin 이 아니면 그 자리 자체가 없다**(문서의 지시 · 규칙 06).
            판정을 `TerminalChip` 과 같게 두어야 서버의 `checkOwnerOrAdmin` 과 갈라지지 않는다.
          */}
          {canSeeConfig && onOpenSettings && (
            <button
              data-testid="profile-settings"
              className="rounded border border-border px-3 py-1.5 text-[13px] font-medium
                         text-fg hover:bg-surface-hover"
              onClick={() => { onClose(); onOpenSettings('agents', account.id); }}
            >
              에이전트 설정
            </button>
          )}
          {account.id !== me?.id && (
            <button
              data-testid="profile-dm"
              className="rounded border border-border px-3 py-1.5 text-[13px] font-medium
                         text-fg hover:bg-surface-hover"
              onClick={() => { onClose(); void getController().startDm(account.id); }}
            >
              DM 열기
            </button>
          )}
        </div>
      </div>
    </Overlay>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3 text-[13px]">
      <dt className="w-24 shrink-0 text-fg-subtle">{label}</dt>
      <dd className={`min-w-0 break-words text-fg ${mono ? 'font-mono text-[12px]' : ''}`}>{value}</dd>
    </div>
  );
}
