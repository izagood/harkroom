import { useEffect, useState } from 'react';
import { ACCOUNT_STATUSES, type AccountStatus } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { useT } from '../i18n/useT';
import type { MessageKey } from '../i18n';

/**
 * 화면에 쓰는 이름. 값 집합은 shared 의 `ACCOUNT_STATUSES` 하나에서 나온다.
 *
 * **저장·전송용 값과 화면 라벨을 갈랐다.** `available`·`away`·`dnd` 는 서버로 가고
 * (`setStatus(s)`) 화면의 `data-status` 로도 남는 값이라 **안 옮긴다** — `sidebar.notify`
 * 가 `all`/`mentions`/`none` 을 안 옮긴 것과 같은 규율이다. 사전에 오는 것은 그 값에
 * 씌우는 이름뿐이다.
 *
 * **표는 남기고 값만 사전 키로 바꿨다**(`NotifiedGapRow::LABEL` 의 선례). 문구를 그대로
 * 두면 이 상수가 **모듈 로드 시점 언어로 굳어**, 사람이 언어를 바꿔도 이 세 버튼만 옛
 * 언어로 남는다. 키는 언어를 안 지니므로 상수여도 안전하고, `Record<AccountStatus, …>`
 * 가 지키던 것(*"상태를 추가하면 컴파일이 막힌다"*)이 그대로 산다.
 *
 * `Identity::STATUS_MARKS` 와 **같은 키를 본다** — 두 화면이 같은 세 상태를 그리므로,
 * 다른 키를 들면 고르는 자리와 읽는 자리의 말이 갈린다(`status` 영역 머리말의 근거).
 */
const LABEL_KEY: Record<AccountStatus, MessageKey> = {
  available: 'status.value.available',
  away: 'status.value.away',
  dnd: 'status.value.dnd',
};

/**
 * 내 상태를 고르는 자리(#186). 사이드바 하단, 내 계정 행이 여는 메뉴 안에서 열린다.
 *
 * **자동 전환도 만료도 없다.** 스스로 풀리는 상태는 "내가 정한 것이 언제 사라지는가"를
 * 사람이 알 수 없게 만든다 — 지우는 것은 사람이 한다. 그래서 문구를 비우는 수단(지우기)이
 * 이 화면에 명시적으로 있어야 한다.
 *
 * 방해 금지는 이번 범위에서 **알림을 억제하지 않는다**. 억제는 기기 로컬 설정(lib/prefs)의
 * 일이고 상태는 계정 속성이라, 둘이 만나는 자리는 따로 정해야 한다(이슈 본문).
 *
 * **자기 트리거를 잃었다(#488 A1).** 예전에는 `대화 가능` 이라는 글자 버튼이 트리거였는데,
 * 그 글자가 이 앱의 **네 번째 상태 어휘**였고 "정상 상태에는 표시를 붙이지 않는다"는
 * 규칙(`Identity.tsx::STATUS_MARKS`)에도 어긋났다. 트리거는 계정 메뉴의 항목으로 옮겼고
 * 이 컴포넌트는 **패널만** 남는다 — 여는 쪽이 소유하므로 `open` 은 여기 상태가 아니다.
 */
export function StatusPicker({ onDone }: {
  /** 상태를 정했거나 사용자가 닫았을 때. 여는 쪽이 닫는 쪽이다. */
  onDone: () => void;
}) {
  const t = useT();
  const me = useActiveStore((s) => s.me);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const statusText = me?.statusText ?? null;

  // 마운트할 때(= 열릴 때) 서버가 아는 값으로 맞춘다. 열려 있는 동안 이벤트로 값이 바뀌어도
  // 사용자가 입력 중인 글자를 빼앗지 않는다 — 그래서 `statusText` 를 의존성에 넣지 않는다.
  // 예전에는 이것이 `open` 전이였고, 패널이 열릴 때만 마운트되는 지금은 마운트가 곧 그 전이다.
  useEffect(() => {
    setText(statusText ?? '');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!me) return null;

  const apply = async (status: AccountStatus, nextText?: string | null): Promise<void> => {
    try {
      await getController().setStatus(status, nextText);
      onDone();
    } catch (err) {
      // 실패를 조용히 삼키면 사용자는 정했다고 믿는데 남들에게는 예전 상태로 보인다.
      setError(err instanceof Error ? err.message : t('status.picker.failed'));
    }
  };

  return (
    <div
      data-testid="status-picker"
      className="mt-1 rounded border border-border bg-surface-raised p-1"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onDone(); } }}
    >
      {ACCOUNT_STATUSES.map((s) => (
        <button
          key={s}
          aria-pressed={me.status === s}
          // 고르는 항목과 입력칸은 **본문단 13px**(앱 기본값이라 안 적는다) — 아래 오류·
          // 버튼은 아랫단 11px 이다. 고르려면 읽어야 하고, 다 고른 뒤 누르는 것과 그 결과는
          // 눈이 이미 가 있는 자리다.
          className={`block w-full rounded px-2 py-1 text-left hover:bg-surface-hover ${me.status === s ? 'text-fg' : 'text-fg-muted'}`}
          // 문구는 넘기지 않는다 — 키 부재가 '손대지 않음'이다. 상태만 바꾸려던
          // 조작이 문구를 함께 지우면 사용자는 왜 사라졌는지 알 수 없다.
          onClick={() => void apply(s)}
        >
          {t(LABEL_KEY[s])}
        </button>
      ))}
      <input
        aria-label={t('status.picker.noteLabel')}
        maxLength={80}
        value={text}
        placeholder={t('status.picker.notePlaceholder')}
        className="mt-1 w-full rounded border border-border bg-field px-2 py-1 text-fg outline-none"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void apply(me.status, text.trim() || null); }}
      />
      {error && <p role="alert" className="mt-1 text-meta text-danger">{error}</p>}
      <div className="mt-1 flex gap-1">
        <button
          className="rounded bg-accent px-2 py-0.5 text-meta text-fg-on-strong hover:bg-accent-hover"
          onClick={() => void apply(me.status, text.trim() || null)}
        >
          {t('status.picker.save')}
        </button>
        {statusText && (
          <button
            className="rounded px-2 py-0.5 text-meta text-fg-muted hover:bg-surface-hover"
            // 지우기는 **명시적 null** 이다. 빈 문자열로 지우면 "문구가 없다"와
            // "빈 문구가 있다"가 섞인다.
            onClick={() => void apply(me.status, null)}
          >
            {t('status.picker.clear')}
          </button>
        )}
        {/*
          닫기(#488 A1). 예전에는 트리거를 다시 눌러 닫았는데 그 트리거가 없어졌다 —
          여는 손잡이를 옮기면서 닫는 손잡이를 안 옮기면 아무것도 안 바꾸고 나올 길이
          사라진다. `Escape` 도 같은 곳으로 간다: 패널 안에서 취소를 기대하는 키다.
        */}
        <button
          className="ml-auto rounded px-2 py-0.5 text-meta text-fg-muted hover:bg-surface-hover"
          onClick={onDone}
        >
          {t('status.picker.close')}
        </button>
      </div>
    </div>
  );
}
