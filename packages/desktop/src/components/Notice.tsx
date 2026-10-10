import { useEffect, useRef, useState } from 'react';
import { useActiveStore } from '../state/communities';
import type { NoticeItem } from '../state/appStore';
import { useT } from '../i18n/useT';

/** 창이 앞에 있고 손이 올라가 있지 않은 시간으로만 잰다. */
export const NOTICE_TTL_MS = 8_000;
const TICK_MS = 250;

/**
 * 조용히 삼키면 안 되는 실패를 사람 앞에 세우는 자리(#178) — 아래 가운데 토스트(2026-10-09 A안).
 *
 * **여기 서는 것은 실패뿐이다.** 성공을 태우지 않는다. 'Link copied.' 가 그래서 빠졌다(복사는
 * 붙여넣으면 됐는지 바로 안다). 관문(터미널 대기)도 여기 서지 않는다 — 그것은 사람이 할
 * 일이라 `GateCard` 가 따로 말한다.
 *
 * 전에는 헤더 아래 **흐름 안의 띠**였다. 뜰 때마다 사이드바·채널·스레드 전체가 한 줄 내려가고,
 * ×를 누르기 전까지 남았다. 이제는 본문 위에 겹쳐 그려 아무것도 밀지 않고, 창이 앞에 있는
 * 동안 8초가 지나면 내려간다. 창이 뒤에 있거나 손을 올려 둔 동안에는 시계가 멈춘다 — 자리를
 * 비운 사이에 뜬 오류를 아무도 못 보고 사라지면 안 된다는 #178 의 우려는 그대로다.
 *
 * `role="alert"` 이라 스크린리더가 뜨는 즉시 읽는다.
 */
export function Notice() {
  const notices = useActiveStore((s) => s.notices);
  if (notices.length === 0) return null;
  return (
    <div
      data-testid="notice-stack"
      className="pointer-events-none absolute inset-x-0 bottom-20 z-40 flex flex-col items-center gap-2 px-4"
    >
      {notices.map((n) => <Toast key={n.id} notice={n} />)}
    </div>
  );
}

function Toast({ notice }: { notice: NoticeItem }) {
  const t = useT();
  const [hover, setHover] = useState(false);
  const left = useRef(NOTICE_TTL_MS);
  useEffect(() => {
    if (hover) return;
    const timer = setInterval(() => {
      if (!document.hasFocus()) return;
      left.current -= TICK_MS;
      if (left.current <= 0) useActiveStore.getState().dismissNotice(notice.id);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [hover, notice.id]);
  return (
    <div
      role="alert"
      data-testid="notice"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="pointer-events-auto flex max-w-xl items-start gap-2 rounded-card border border-border bg-surface-raised px-3 py-2 text-body text-fg shadow-float"
    >
      <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-danger" />
      <span className="min-w-0 flex-1 break-words">{notice.text}</span>
      <button
        type="button"
        className="shrink-0 rounded-sm px-1 text-fg-muted hover:bg-surface-hover"
        aria-label={t('notice.dismiss')}
        onClick={() => useActiveStore.getState().dismissNotice(notice.id)}
      >
        ×
      </button>
    </div>
  );
}
