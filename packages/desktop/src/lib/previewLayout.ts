/**
 * 미리보기(아티팩트)가 열린 동안 무엇을 접나(designer 수정 1, #1069). **내용 칸은 둘** — 카드를 누른 칸 +
 * 미리보기다. 스레드 안 카드면 채널 칸을, 채널 본문 카드면 스레드를 잠시 접고, 터미널은 늘 접는다. 상태는
 * 건드리지 않으므로 미리보기를 닫으면 접었던 칸이 그대로 돌아온다.
 *
 * 왜: 셋을 나란히 두면 1440px 창에서 채널 칸이 ~70px 로 짓눌렸다(레일+사이드바 330 + 스레드 711 + 미리보기 640).
 */
export interface PreviewLayout {
  hideMain: boolean;
  hideThread: boolean;
  hideTerminal: boolean;
  /** 곁의 칸이 고정 폭(스레드)이라 남는 폭을 미리보기가 채운다. */
  fillPreview: boolean;
}

export function previewLayout(previewFrom: 'channel' | 'thread' | null, threadOpen: boolean): PreviewLayout {
  if (previewFrom === null) return { hideMain: false, hideThread: false, hideTerminal: false, fillPreview: false };
  const fromThread = previewFrom === 'thread' && threadOpen;
  return { hideMain: fromThread, hideThread: !fromThread, hideTerminal: true, fillPreview: fromThread };
}
