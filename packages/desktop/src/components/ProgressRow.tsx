import { useState } from 'react';
import type { MessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { displayBody } from '../lib/mention';
import { elapsedMs } from '../lib/progressGroup';
import { runningLabel, tookLabel } from '../lib/time';
import { useT, useLocale } from '../i18n/useT';
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
export function ProgressRow({ messages, endedAt = null }: {
  messages: MessageRow[];
  /**
   * 이 진행이 끝난 시각(`progressGroup.ts::Slot` 참고). 있으면 **과거로 그린다** —
   * 도는 점을 중립으로 바꾸고, 경과를 `Date.now()` 가 아니라 이 시각으로 잰다.
   *
   * 기본값이 `null` 인 이유: 이 컴포넌트를 쓰는 자리가 둘(채널·스레드)이고, 둘 다
   * 슬롯에서 값을 받는다. 기본값은 옛 호출부를 위한 것이 아니라 **"모르면 도는 것으로
   * 둔다"** 는 판정이다 — 끝났다고 단정하는 쪽이 더 나쁜 거짓이다.
   */
  endedAt?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const author = useActiveStore((s) => s.accounts[messages[0]!.authorId]);
  // 진행 본문도 본문 렌더러를 지나지 않는다 — `<@id>` 를 여기서 푼다(`lib/mention` 주석).
  const accounts = useActiveStore((s) => s.accounts);
  const first = messages[0]!;
  const last = messages[messages.length - 1]!;

  const t = useT();
  const locale = useLocale();

  // 경과는 **묶음의 시작**부터 잰다(`elapsedMs` 주석 참고). 끝난 묶음은 그 끝까지만
  // 잰다 — `Date.now()` 로 재면 15:08 에 끝난 진행이 15:15 에 "11분째" 로 보인다
  // (2026-09-07 실측: 사용자가 그 화면을 보고 "죽었나 도나?" 를 물었다).
  const ended = endedAt === null ? null : new Date(endedAt).getTime();
  const 끝났다 = ended !== null && !Number.isNaN(ended);
  const ms = elapsedMs(first.createdAt, 끝났다 ? ended! : Date.now());
  // **두 상태를 사전 항목 둘로 가른다**(`lib/time.ts::runningLabel` 주석). 여기 있던
  // `elapsed.replace(/째$/, '')` 는 한국어 어미를 정규식으로 자르던 것이라 다른 언어에서
  // 아무것도 안 잘렸다 — 영어 화면이 "끝난 진행"과 "도는 진행"을 같은 글자로 말했다.
  const elapsed = ms === null ? null : 끝났다 ? tookLabel(ms, locale, t) : runningLabel(ms, locale, t);
  const name = author?.handle ?? '…';

  return (
    <div data-testid="progress-row" className="px-4 py-0.5">
      <div className="flex items-center gap-1.5 text-meta text-fg-muted">
        {/* 점은 `state-running` 이다 — 강조가 아니다. 도는 것은 나를 막지 않는다(규칙 03).
            끝난 묶음은 중립색이다: 색이 상태를 말하는 자리이므로, 끝난 것이 계속 도는
            색으로 남으면 글자를 고쳐도 화면은 여전히 "돈다"고 말한다. */}
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${끝났다 ? 'bg-fg-subtle' : 'bg-state-running'}`}
        />
        <span className="font-medium text-fg-agent">{name}</span>
        {/* 끝났으면 상태가 아니라 **기록**이다 — "작업 중" 은 지금을 말하는 말이다. */}
        <span>{끝났다 ? '작업' : '작업 중'}</span>
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
            <li key={m.id} className="text-meta text-fg-subtle">{displayBody(m, accounts)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
