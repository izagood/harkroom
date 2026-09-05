import { useState } from 'react';
import type { MessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { elapsedLabel } from '../lib/progressGroup';
import { TerminalChip } from './TerminalChip';

/**
 * 진행(progress)을 **상태 한 줄**로 그린다(규칙 02 · 계획 Task 4).
 *
 * 진행은 답이 필요 없는 구간이다 — 도구를 부르고 파일을 고치는 그 과정은 대화에 쓰지
 * 않는다. 그래서 말풍선이 아니라 점 + 저자 + 경과 한 줄이고, **자세히는 터미널**이 답한다.
 *
 * **본문을 문장으로 그리지 않는다.** progress 본문은 요약의 재료이지 발화가 아니다 —
 * 그대로 흘리면 지금까지와 똑같이 로그가 대화가 된다. 다만 **버리지도 않는다**: 펼치면
 * 접힌 줄들이 보인다. 러너가 남긴 유일한 진행 기록이라 사라지면 "그때 무엇을 하고
 * 있었나"에 답할 것이 없어진다.
 */
export function ProgressRow({ messages }: { messages: MessageRow[] }) {
  const [open, setOpen] = useState(false);
  const author = useActiveStore((s) => s.accounts[messages[0]!.authorId]);
  const first = messages[0]!;
  const last = messages[messages.length - 1]!;

  // 경과는 **묶음의 시작**부터 잰다(`elapsedLabel` 주석 참고).
  const elapsed = elapsedLabel(first.createdAt, Date.now());
  const name = author?.handle ?? '…';

  return (
    <div data-testid="progress-row" className="px-4 py-0.5">
      <div className="flex items-center gap-1.5 text-[11px] text-fg-muted">
        {/* 점은 `state-running` 이다 — 강조가 아니다. 도는 것은 나를 막지 않는다(규칙 03). */}
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-state-running" />
        <span className="font-medium text-fg-agent">{name}</span>
        <span>작업 중</span>
        {elapsed && <span className="text-fg-subtle">· {elapsed}</span>}
        {/*
          접힌 개수는 **둘 이상일 때만** 말한다. 하나뿐인데 "1줄"이라고 적으면 접힌 것이
          없는데 접혔다고 말하는 셈이고, 규칙 06(없는 것은 자리를 차지하지 않는다)에 걸린다.
        */}
        {messages.length > 1 && (
          <button
            data-testid="progress-expand"
            className="rounded px-1 text-fg-subtle hover:bg-surface-hover"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '접기' : `${messages.length}줄 펼치기`}
          </button>
        )}
        {/*
          터미널로 가는 길(규칙 06). 소유자·admin 이 아니면 `TerminalChip` 이 스스로 렌더를
          하지 않는다 — 비활성이 아니라 부재다. 판정을 여기서 다시 쓰지 않고 그 컴포넌트를
          그대로 재사용하는 것이 요점이다: 두 곳에 두면 한쪽만 고쳐진다.
        */}
        <TerminalChip account={author} message={last} />
      </div>
      {open && (
        <ul data-testid="progress-detail" className="mt-1 space-y-0.5 border-l border-border-agent pl-2">
          {messages.map((m) => (
            <li key={m.id} className="text-[11px] text-fg-subtle">{m.body}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
