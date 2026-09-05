import { readReportMeta, type MessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';

/**
 * 완료 보고 카드 — **이 스레드에서 가장 오래 남고 가장 많이 다시 읽히는 말**이다(규칙 03).
 *
 * ## 강조색을 쓰지 않는다
 *
 * 읽히는 말이지 막는 말이 아니다. 보고에 강조를 주면 "내 차례"라는 신호가 그만큼 흐려진다 —
 * 그래서 테두리도 면도 무채색이고, 여기서 유일하게 색을 받는 것은 **남은 것**뿐이다
 * (그것만이 아직 닫히지 않은 사실이다).
 *
 * ## 형식을 안 지키면 조용히 사라진다
 *
 * `checks` 가 비면 `readReportMeta` 가 `null` 을 주고 이 컴포넌트는 아무것도 그리지 않는다 —
 * `MessageItem` 이 본문을 이미 그렸으므로 사람은 평문으로 읽는다. 빈 상자는 거짓 신호다.
 */
export function ReportCard({ message, inThread = false }: {
  message: MessageRow;
  /** 스레드 안이면 작성창의 scope 가 다르다 — `FailureCard` 와 같은 규약이다. */
  inThread?: boolean;
}) {
  const setDraft = useActiveStore((s) => s.setDraft);
  const report = readReportMeta(message.meta);
  if (!report) return null;

  const scope = inThread ? `thread:${message.threadRootId ?? message.id}` : message.channelId;

  return (
    <div
      data-testid="report-card"
      className="mt-1.5 max-w-prose rounded-lg border border-border bg-surface-sunken px-3 py-2"
    >
      <Section title="확인한 것" testid="report-checks" items={report.checks} />
      {/* 파일 경로만 고정폭이다 — 문장과 섞이면 줄이 흔들린다. */}
      {report.files?.length ? (
        <Section title="바뀐 파일" testid="report-files" items={report.files} mono />
      ) : null}
      {report.remaining?.length ? (
        <Section title="남은 것" testid="report-remaining" items={report.remaining} tone="text-warning" />
      ) : null}

      {report.durationMs != null && (
        <p className="mt-1.5 text-[11px] text-fg-subtle">{formatDuration(report.durationMs)}</p>
      )}

      {/*
        다음 제안 칩 — 누르면 **작성창을 채운다**(보내지 않는다). 한 번의 확인을 남기는 것이
        `FailureCard` 의 '다시 부르기'와 같은 규약이다: 누르자마자 나가면 사람이 무엇이
        나갈지 보지 못한 채 러너가 또 돈다.
      */}
      {report.next?.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {report.next.map((n) => (
            <button
              key={n.id}
              data-testid={`report-next-${n.id}`}
              // **본문 크기로 그린다**(13px). 이 카드에서 유일하게 누르는 물건인데 보조
              // 텍스트(11px)보다 작으면 안 된다 — 읽고 고르는 것이므로 `AskCard` 의 옵션과
              // 같은 크기여야 한다. 세로 여백도 함께 키워 손가락·커서가 닿을 자리를 준다.
              className="rounded-md border border-border bg-surface-raised px-3 py-1.5 text-[13px]
                         font-medium text-fg hover:border-fg-subtle hover:bg-surface-hover"
              onClick={() => setDraft(scope, n.label)}
            >
              {n.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, items, testid, mono = false, tone = 'text-fg-muted' }: {
  title: string;
  items: string[];
  testid: string;
  mono?: boolean;
  tone?: string;
}) {
  return (
    <div className="mb-1.5 last:mb-0">
      <h4 className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">{title}</h4>
      <ul data-testid={testid} className="mt-0.5 space-y-0.5">
        {items.map((it) => (
          // 넉넉한 행간 — 다시 읽히는 글이므로 읽기 품질이 전부다.
          <li key={it} className={`text-[13px] leading-relaxed ${mono ? 'font-mono text-[12px]' : ''} ${tone}`}>
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 사람이 읽는 소요 시간. 초 단위 밑은 반올림한다 — 정밀도가 정보를 더하지 않는다. */
function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}초`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return rest ? `${min}분 ${rest}초` : `${min}분`;
}
