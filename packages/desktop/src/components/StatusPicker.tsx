import { useEffect, useState } from 'react';
import { ACCOUNT_STATUSES, type AccountStatus } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';

/** 화면에 쓰는 이름. 값 집합은 shared 의 `ACCOUNT_STATUSES` 하나에서 나온다. */
const LABELS: Record<AccountStatus, string> = {
  available: '대화 가능',
  away: '자리 비움',
  dnd: '방해 금지',
};

/**
 * 내 상태를 고르는 자리(#186). 사이드바 하단, 내 계정 행 옆에 붙는다.
 *
 * **자동 전환도 만료도 없다.** 스스로 풀리는 상태는 "내가 정한 것이 언제 사라지는가"를
 * 사람이 알 수 없게 만든다 — 지우는 것은 사람이 한다. 그래서 문구를 비우는 수단(지우기)이
 * 이 화면에 명시적으로 있어야 한다.
 *
 * 방해 금지는 이번 범위에서 **알림을 억제하지 않는다**. 억제는 기기 로컬 설정(lib/prefs)의
 * 일이고 상태는 계정 속성이라, 둘이 만나는 자리는 따로 정해야 한다(이슈 본문).
 */
export function StatusPicker() {
  const me = useAppStore((s) => s.me);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 패널을 열 때마다 서버가 아는 값으로 맞춘다. 열려 있는 동안 이벤트로 값이 바뀌어도
  // 사용자가 입력 중인 글자를 빼앗지 않기 위해 열림 전이에서만 동기화한다.
  useEffect(() => {
    if (open) { setText(me?.statusText ?? ''); setError(null); }
  }, [open, me?.statusText]);

  if (!me) return null;

  const apply = async (status: AccountStatus, statusText?: string | null): Promise<void> => {
    try {
      await getController().setStatus(status, statusText);
      setOpen(false);
    } catch (err) {
      // 실패를 조용히 삼키면 사용자는 정했다고 믿는데 남들에게는 예전 상태로 보인다.
      setError(err instanceof Error ? err.message : '상태를 바꾸지 못했다');
    }
  };

  return (
    <div className="relative">
      <button
        aria-label="내 상태"
        aria-expanded={open}
        className="rounded px-1 py-0.5 text-[11px] text-fg-muted hover:bg-surface-hover"
        onClick={() => setOpen((v) => !v)}
      >
        {LABELS[me.status]}
        {me.statusText && <span className="ml-1 text-fg-subtle">{me.statusText}</span>}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-1 w-52 rounded border border-border bg-surface-raised p-1">
          {ACCOUNT_STATUSES.map((s) => (
            <button
              key={s}
              aria-pressed={me.status === s}
              className={`block w-full rounded px-2 py-1 text-left text-xs hover:bg-surface-hover ${me.status === s ? 'text-fg' : 'text-fg-muted'}`}
              // 문구는 넘기지 않는다 — 키 부재가 '손대지 않음'이다. 상태만 바꾸려던
              // 조작이 문구를 함께 지우면 사용자는 왜 사라졌는지 알 수 없다.
              onClick={() => void apply(s)}
            >
              {LABELS[s]}
            </button>
          ))}
          <input
            aria-label="상태 문구"
            maxLength={80}
            value={text}
            placeholder="짧은 문구 (최대 80자)"
            className="mt-1 w-full rounded border border-border bg-field px-2 py-1 text-xs text-fg outline-none"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void apply(me.status, text.trim() || null); }}
          />
          {error && <p role="alert" className="mt-1 text-[10px] text-danger">{error}</p>}
          <div className="mt-1 flex gap-1">
            <button
              className="rounded bg-accent px-2 py-0.5 text-[11px] text-fg-on-strong hover:bg-accent-hover"
              onClick={() => void apply(me.status, text.trim() || null)}
            >
              저장
            </button>
            {me.statusText && (
              <button
                className="rounded px-2 py-0.5 text-[11px] text-fg-muted hover:bg-surface-hover"
                // 지우기는 **명시적 null** 이다. 빈 문자열로 지우면 "문구가 없다"와
                // "빈 문구가 있다"가 섞인다.
                onClick={() => void apply(me.status, null)}
              >
                문구 지우기
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
