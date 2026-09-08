import { readWakeMeta, type MessageRow } from '@murmur/shared';
import { displayBody } from '../lib/mention';
import { useActiveStore } from '../state/communities';

/**
 * 기다림을 **상태 한 줄**로 그린다(마이그레이션 040 · 규칙 02).
 *
 * 이 줄이 있는 이유: 2026-09-07 15:15 에 사용자가 화면을 보고 물은 것이 "죽었나 도나?"
 * 였고, 화면은 그 답을 갖고 있지 않았다. 예약이 보이지 않으면 **조용히 기다리는 6분과
 * 죽은 6분이 똑같이 보인다** — 그래서 이 한 줄이 예약의 존재 이유의 절반을 차지한다.
 *
 * 말풍선이 아닌 이유: 발화가 아니다. 러너의 발화 판정도 이것을 세지 않는다
 * (agent/src/prompt.ts::countOwnPostsSince) — 화면과 러너가 같은 것을 같게 본다.
 *
 * 시각을 `toLocaleTimeString` 으로 읽는 이유: 서버는 ISO 사실만 싣는다(`readWakeMeta`
 * 주석). 문자열로 구워 보냈다면 이 줄은 다른 시간대에서 거짓을 말하게 된다.
 */
export function WakeRow({ message }: { message: MessageRow }) {
  const author = useActiveStore((s) => s.accounts[message.authorId]);
  // 사유도 본문이다 — 본문 렌더러를 지나지 않으므로 `<@id>` 를 여기서 푼다(`lib/mention` 주석).
  const accounts = useActiveStore((s) => s.accounts);
  const wake = readWakeMeta(message.meta);
  const at = wake === null ? null : new Date(wake.wakeAt);
  // 시각을 못 읽어도 줄은 그린다 — 대기 자체가 사실이고, 시각을 모르는 것이 그 사실을 지우지 않는다.
  const label = at === null || Number.isNaN(at.getTime())
    ? null
    : at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return (
    <div data-testid="wake-row" className="px-4 py-0.5">
      <div className="flex items-center gap-1.5 text-[11px] text-fg-muted">
        {/* 시계는 강조가 아니다 — 기다리는 것은 나를 막지 않는다(규칙 03). */}
        <span aria-hidden="true" className="shrink-0">🕐</span>
        <span className="font-medium text-fg-agent">{author?.handle ?? '…'}</span>
        {label === null ? <span>다시 봅니다</span> : <span>{label} 에 다시 봅니다</span>}
        <span className="text-fg-subtle">· {displayBody(message, accounts)}</span>
      </div>
    </div>
  );
}
