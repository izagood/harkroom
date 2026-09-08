import { readReportMeta, type MessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { durationLabel } from '../lib/time';
import { useLocale, useT } from '../i18n/useT';

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
  // 소요 시간은 `lib/time.ts` 가, 세 구획의 머리는 사전이 낸다.
  const locale = useLocale();
  const t = useT();
  const report = readReportMeta(message.meta);
  if (!report) return null;

  const scope = inThread ? `thread:${message.threadRootId ?? message.id}` : message.channelId;

  return (
    <div
      data-testid="report-card"
      className="mt-1.5 max-w-prose rounded-lg border border-border bg-surface-sunken px-3 py-2"
    >
      <Section title={t('speech.report.checks')} testid="report-checks" items={report.checks} />
      {/* 파일 경로만 고정폭이다 — 문장과 섞이면 줄이 흔들린다. */}
      {report.files?.length ? (
        <Section title={t('speech.report.files')} testid="report-files" items={report.files} mono />
      ) : null}
      {report.remaining?.length ? (
        <Section title={t('speech.report.remaining')} testid="report-remaining" items={report.remaining} tone="text-warning" />
      ) : null}

      {report.durationMs != null && (
        <p className="mt-1.5 text-meta text-fg-subtle">{durationLabel(report.durationMs, locale)}</p>
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
              className="rounded-md border border-border bg-surface-raised px-3 py-1.5 text-body
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
      <h4 className="text-meta font-semibold uppercase tracking-wide text-fg-subtle">{title}</h4>
      <ul data-testid={testid} className="mt-0.5 space-y-0.5">
        {items.map((it) => (
          // 넉넉한 행간 — 다시 읽히는 글이므로 읽기 품질이 전부다.
          //
          // `mono` 의 12px 은 4단(11/13/15/17) 밖이지만 **같은 본문단을 맞추기 위한 값**이다:
          // 등폭 글꼴은 같은 pt 에서 산세리프보다 크게 보여(x-height·전진폭이 넓다) 13px 로
          // 두면 옆줄의 13px 본문보다 한 단 커 보인다. 한 단 내려 광학적으로 같은 크기를
          // 만든다 — 단을 어긴 것이 아니라 단을 지키기 위한 보정이다. `Profile.tsx` 의
          // `Row` 가 같은 쌍(본문 13 / mono 12)을 쓴다.
          <li key={it} className={`text-body leading-relaxed ${mono ? 'font-mono text-[12px]' : ''} ${tone}`}>
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

// 소요 시간은 `lib/time.ts::durationLabel` 한 벌이다(`#619` 후속). 여기 있던
// `formatDuration` 은 그 함수와 **같은 판정의 여섯 번째 사본**이었다 — 단위를 갈라
// 그 언어의 말로 적는 것이 하는 일의 전부였고, 다른 점은 초 미만을 반올림하느냐
// 버리느냐뿐이었다(밀리초는 이 카드에 실리지 않으므로 화면에 차이가 안 난다).
