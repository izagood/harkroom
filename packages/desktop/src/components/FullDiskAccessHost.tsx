import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import { FullDiskAccessDialog } from './FullDiskAccessDialog';
import { fdaPromptStorage, getFdaSurface, shouldPrompt, useFdaStatus } from '../lib/fullDiskAccess';

/**
 * 작업 화면에 붙는 전체 디스크 접근 자리 — **첫 안내 창**과 **다시 시작 띠**.
 *
 * - 안내 창: 로그인한 뒤 권한이 **없다고 확인되면** 이 기기에서 한 번만 띄운다(소유자 결정 #1·#2). 띄우는 순간
 *   「띄웠음」을 적는다 — 어떻게 닫든 다시 묻지 않는다.
 * - 다시 시작 띠: 켜졌는데 **이 프로세스가 아직 막혀 있을 때만**(`restart`) 선다(소유자 결정 #8). 다시 시작한 뒤
 *   켜짐으로 읽히면 상태가 `on` 이라 서지 않는다. [나중에] 는 이번 실행 동안만 접는다 — 설정 줄에는 남는다.
 */
export function FullDiskAccessHost() {
  const t = useT();
  const { status } = useFdaStatus();
  const [open, setOpen] = useState(false);
  const [bandHidden, setBandHidden] = useState(false);
  const [bandError, setBandError] = useState<string | null>(null);

  useEffect(() => {
    if (status && shouldPrompt(status, fdaPromptStorage.wasShown())) {
      fdaPromptStorage.markShown();
      setOpen(true);
    }
  }, [status]);

  return (
    <>
      {status === 'restart' && !open && !bandHidden && (
        <div
          role="status"
          data-testid="fda-restart-band"
          className="flex items-center gap-2 border-b border-warning-border bg-warning-surface px-4 py-2 text-body text-fg"
        >
          <span className="flex-1">{bandError ?? t('fda.band')}</span>
          <button data-testid="fda-band-later" className="shrink-0 rounded-row border border-border px-2 py-0.5 hover:bg-warning-surface-strong" onClick={() => setBandHidden(true)}>
            {t('fda.bandLater')}
          </button>
          <button
            data-testid="fda-band-restart"
            className="shrink-0 rounded-row bg-accent px-2 py-0.5 font-medium text-fg-on-strong hover:bg-accent-hover"
            onClick={() => { getFdaSurface().relaunch().catch(() => setBandError(t('fda.restartFailed'))); }}
          >
            {t('fda.restart')}
          </button>
        </div>
      )}
      {open && <FullDiskAccessDialog status={status} onClose={() => setOpen(false)} />}
    </>
  );
}
