import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { useT } from '../i18n/useT';

/**
 * **끊긴 동안·다시 붙는 동안**을 본문 맨 위 띠로 말한다(A3, designer 시안 ①·③, jaebin D1·D2).
 *
 * 전에는 끊긴 것을 알리는 것이 사이드바 왼쪽 위 빨간 점 하나뿐이었다 — 사람은 받아 둔 글을
 * 보면서 그것이 최신이 아닐 수 있다는 것을 몰랐다.
 *
 * - 국면은 컨트롤러가 정한다(`link`). 소켓(`connected`)을 직접 보지 않는 이유: 1~2초 끊김마다
 *   띠가 서면 화면이 한 줄씩 밀리는 깜빡임이다(`ProjectionBanner` 의 「확인하는 중」과 같은 원칙).
 * - **닫기 없음.** 사실이 바뀌면 저절로 걷힌다 — 닫아 둔 띠 뒤에서 끊김이 이어지면 다시 모르게 된다.
 * - 다시 붙으면 초록 띠를 맞추기가 끝날 때까지 둔다. 바로 걷으면 그 사이 들어온 글이 원래 있던
 *   것처럼 보인다. 새 글 수는 쓰지 않는다 — 새 글 구분선·사이드바 미읽음이 이미 하는 일이다(D2).
 */
export function ConnectionBanner() {
  const link = useActiveStore((s) => s.link);
  const t = useT();
  if (link === 'online') return null;

  if (link === 'resyncing') {
    return (
      <div role="status" data-testid="strip-link-resyncing"
        className="flex items-center gap-2 border-b border-transparent bg-success-surface px-4 py-2 text-body text-success">
        <Spinner />
        <span><b className="font-semibold">{t('link.resyncing.title')}</b> — {t('link.resyncing.detail')}</span>
      </div>
    );
  }

  if (link === 'resyncFailed') {
    return (
      <div role="alert" data-testid="strip-link-resync-failed"
        className="flex items-center gap-2 border-b border-warning-border bg-warning-surface px-4 py-2 text-body text-warning">
        <span className="flex-1">{t('link.resyncFailed')}</span>
        <button type="button" data-testid="link-resync-retry"
          className="rounded-row border border-warning-border px-2 py-0.5 hover:bg-warning-surface-strong"
          onClick={() => getController().retryResync()}>
          {t('link.resyncFailed.retry')}
        </button>
      </div>
    );
  }

  return (
    <div role="alert" data-testid="strip-link-offline"
      className="flex items-center gap-2 border-b border-warning-border bg-warning-surface px-4 py-2 text-body text-warning">
      <Spinner />
      <span className="flex-1"><b className="font-semibold">{t('link.offline.title')}</b> — {t('link.offline.detail')}</span>
      <span className="shrink-0 opacity-80">{t('link.offline.reconnecting')}</span>
    </div>
  );
}

function Spinner() {
  return <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin" />;
}
