import type { MessageRow } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { useT } from '../i18n/useT';
import type { SectionId } from './settings/sections';

/**
 * 비밀 만들기 알림 줄(서버 `notifyOwner`, `meta.secretNotice`)의 버튼. 본문은 서버가 쓴 고정 문구라 그대로 둔다 —
 * 여기서 하는 일은 **소유자에게만** 설정 › 비밀과 API 로 가는 길을 하나 세우는 것뿐이다. 남에게는 아무것도 그리지 않는다.
 */
export function SecretNoticeAction({ message, onOpenSettings }: { message: MessageRow; onOpenSettings?: (section?: SectionId, targetId?: string) => void }) {
  const t = useT();
  const myId = useActiveStore((s) => s.me?.id);
  const n = message.meta.secretNotice as { ownerAccountId?: unknown } | undefined;
  if (!onOpenSettings || !n || typeof n.ownerAccountId !== 'string' || n.ownerAccountId !== myId) return null;
  return (
    <button
      className="mt-1 rounded-card border border-border px-2 py-1 text-meta font-medium text-fg hover:bg-surface-hover"
      data-testid="secret-notice-open"
      onClick={() => onOpenSettings('secrets')}
    >
      {t('secrets.notice.open')}
    </button>
  );
}
