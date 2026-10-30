import { useEffect, useRef, useState } from 'react';
import { Overlay } from './Overlay';
import { useT } from '../i18n/useT';
import { errorText } from '../lib/errorText';
import { getFdaSurface, type FdaStatus } from '../lib/fullDiskAccess';

/**
 * 전체 디스크 접근 **안내 창**(시안 v2, 소유자 결정 2026-10-29).
 *
 * ## 지키는 것 (security S1·S2)
 *
 * - 경고 상자는 접거나 줄이지 않는다: 홈 폴더 전체를 **묻지 않고 읽고 바꿀 수** 있다 · **다른 멤버가 요청한 턴도**
 *   같은 권한을 쓴다. 아래 한 줄: 켜지 않아도 그대로 작동한다 · 켜도 언제든 끌 수 있다.
 * - 두 버튼은 **같은 모양**이다(어느 쪽도 색을 채우지 않는다). 처음 포커스는 [지금은 안 함] — 창이 뜬 줄 모르고
 *   Enter 를 친 사람이 권한을 넓히지 않게. 「권장」 같은 말은 쓰지 않는다.
 *
 * ## 단계
 *
 * `intro` → [시스템 설정 열기] → `waiting`(창을 닫지 않는다. 포커스가 돌아올 때마다 부르는 쪽이 다시 확인해
 * `status` 를 바꿔 준다) → 켜짐이면 `on`, 켜졌는데 이 프로세스가 아직 막혀 있으면 `restart`.
 */
export function FullDiskAccessDialog({ status, onClose }: {
  /** 지금 확인 결과. 부르는 쪽이 포커스마다 다시 읽어 넘긴다. */
  status: FdaStatus | null;
  onClose: () => void;
}) {
  const t = useT();
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notNowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { notNowRef.current?.focus(); }, []);

  const phase: 'intro' | 'waiting' | 'on' | 'restart' =
    status === 'on' ? 'on' : status === 'restart' ? 'restart' : opened ? 'waiting' : 'intro';

  const run = (fn: () => Promise<void>) => {
    setError(null);
    fn().catch((e) => setError(t('fda.actionFailed', { reason: errorText(e, t) })));
  };
  const openSettings = () => run(async () => { await getFdaSurface().openSettings(); setOpened(true); });

  const plainBtn = 'rounded-row border border-border px-3 py-1 text-fg hover:bg-surface-sunken';

  return (
    <Overlay label={t('fda.title')} onClose={onClose} align="center" className="w-[28rem]">
      <div data-testid="fda-dialog" data-phase={phase} className="flex flex-col gap-3 break-keep p-5 [overflow-wrap:anywhere]">
        {phase === 'intro' && (
          <>
            <p className="text-balance text-title font-semibold text-fg">{t('fda.title')}</p>
            <p className="text-fg-muted">{t('fda.why')}</p>
            <div data-testid="fda-risk" className="rounded-row border border-warning-border bg-warning-surface px-3 py-2.5 text-fg">
              <span className="mb-0.5 block text-meta font-semibold text-warning">{t('fda.riskHead')}</span>
              <p>{t('fda.risk')}</p>
              <p className="mt-1.5">{t('fda.members')}</p>
            </div>
            <ol className="flex list-decimal flex-col gap-1 pl-5 marker:text-fg-muted">
              <li>{t('fda.step1')}</li>
              <li>{t('fda.step2')}</li>
              <li>{t('fda.step3')}</li>
            </ol>
            <p className="text-meta text-fg-muted">{t('fda.later')}</p>
            {error && <p role="alert" className="text-meta text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <button ref={notNowRef} data-testid="fda-not-now" className={plainBtn} onClick={onClose}>{t('fda.notNow')}</button>
              <button data-testid="fda-open-settings" className={plainBtn} onClick={openSettings}>{t('fda.openSettings')}</button>
            </div>
          </>
        )}
        {phase === 'waiting' && (
          <>
            <p className="text-balance text-title font-semibold text-fg">{t('fda.waitTitle')}</p>
            <p className="flex items-center gap-2 text-fg-muted">
              <span aria-hidden className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-border border-t-accent" />
              {t('fda.waiting')}
            </p>
            <ol className="flex list-decimal flex-col gap-1 pl-5 marker:text-fg-muted">
              <li>{t('fda.wait1')}</li>
              <li>{t('fda.wait2')}</li>
              <li>{t('fda.wait3')}</li>
            </ol>
            {error && <p role="alert" className="text-meta text-danger">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <button ref={notNowRef} data-testid="fda-close" className="rounded-row px-2 py-1 text-fg-muted hover:bg-surface-sunken" onClick={onClose}>{t('fda.close')}</button>
              <button data-testid="fda-reveal-app" className={plainBtn} onClick={() => run(() => getFdaSurface().revealApp())}>{t('fda.revealApp')}</button>
              <button data-testid="fda-open-again" className={plainBtn} onClick={openSettings}>{t('fda.openAgain')}</button>
            </div>
          </>
        )}
        {(phase === 'on' || phase === 'restart') && (
          <>
            <p className="text-balance text-title font-semibold text-fg"><span aria-hidden className="mr-1 text-success">✓</span>{t('fda.onTitle')}</p>
            <p className="text-fg-muted">{t('fda.onBody')}</p>
            {phase === 'restart' && (
              <p data-testid="fda-restart-note" className="border-t border-dashed border-border pt-2 text-meta text-fg-muted">{t('fda.restartNote')}</p>
            )}
            {error && <p role="alert" className="text-meta text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              {phase === 'on' ? (
                <button data-testid="fda-done" className={plainBtn} onClick={onClose}>{t('fda.ok')}</button>
              ) : (
                <>
                  <button data-testid="fda-restart-later" className={plainBtn} onClick={onClose}>{t('fda.restartLater')}</button>
                  {/* 권한을 넓히는 버튼이 아니라 S2(같은 무게) 대상이 아니다 — 시안 v2 그대로 주 동작 색. */}
                  <button data-testid="fda-restart-now" className="rounded-row bg-accent px-3 py-1 font-medium text-fg-on-strong hover:bg-accent-hover" onClick={() => run(() => getFdaSurface().relaunch())}>{t('fda.restartNow')}</button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Overlay>
  );
}
