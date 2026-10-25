import type { ReactNode } from 'react';
import { messageLinkFromMeta } from '../lib/link';
import { getController } from '../state/controller';

/**
 * 카드 안 메시지 링크(원본 열기·새 카드·글로 답함). 본문 링크(`MessageBody` 의 `BodyLink`)처럼 **앱 안에서** 옮겨 간다 —
 * `harkroom://` 를 웹뷰에 맡기면 아무 일도 일어나지 않는다. 받는 것은 메시지 id 하나뿐이고(`messageLinkFromMeta` 가 꼴을 본다),
 * 이동은 `openMessage` 가 한다(가시성 검사·실패 알림이 거기 있다). id 가 꼴에 안 맞으면 아무것도 그리지 않는다.
 */
export function CardMessageLink({ messageId, className, testId, children }: {
  messageId: unknown; className: string; testId?: string; children: ReactNode;
}) {
  const href = messageLinkFromMeta(messageId);
  if (!href || typeof messageId !== 'string') return null;
  return (
    <a
      className={className}
      href={href}
      data-testid={testId}
      onClick={(e) => {
        e.preventDefault();
        void getController().openMessage(messageId);
      }}
    >
      {children}
    </a>
  );
}
