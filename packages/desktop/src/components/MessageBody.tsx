import { useMemo } from 'react';
import { useAppStore } from '../state/appStore';
import { splitMentions } from '../lib/mention';

/**
 * 본문을 그리면서 멘션만 강조한다. 존재하는 handle 만 칠한다 — 오타를 멘션처럼 보여 주면
 * 사용자는 알림이 갔다고 착각한다.
 */
export function MessageBody({ body }: { body: string }) {
  const accounts = useAppStore((s) => s.accounts);
  const myHandle = useAppStore((s) => s.me?.handle?.toLowerCase() ?? null);

  const parts = useMemo(
    () => splitMentions(body, Object.values(accounts).map((a) => a.handle)),
    [body, accounts],
  );

  return (
    <div className="whitespace-pre-wrap break-words" data-testid="message-body">
      {parts.map((p, i) => {
        if (p.kind === 'text') return <span key={i}>{p.text}</span>;
        const isSelf = p.handle === myHandle;
        return (
          <span
            key={i}
            data-testid={`mention-${p.handle}`}
            data-self={String(isSelf)}
            // 나를 부른 멘션은 더 강하게. 색만으로 구분하지 않는다(배경 + 굵기).
            className={`rounded px-0.5 font-medium ${
              isSelf ? 'bg-amber-200 text-amber-900' : 'bg-indigo-50 text-indigo-700'
            }`}
          >
            {p.text}
          </span>
        );
      })}
    </div>
  );
}
