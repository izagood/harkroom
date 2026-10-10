import { useRef, useState } from 'react';
import { copyText } from '../lib/clipboard';
import { writeConcealed } from '../lib/concealedClipboard';
import { useT } from '../i18n/useT';

/**
 * 워크스페이스를 만든 직후 **한 번만** 보여 주는 복구 키.
 *
 * ## 무엇이고 왜 한 번뿐인가
 *
 * 복구 키는 그 워크스페이스 비밀 보관소의 마스터 키 그 자체다. 호스팅 클러스터를 잃고 다시 세웠을 때 이것이
 * 있어야 보관소가 돌아온다. 운영자는 남의 키를 갖지 않으므로 서비스는 키를 저장하지 않고 다시 보여 줄 수도
 * 없다 — 생성 응답에 한 번 실려 오고, 만든 사람이 지금 받아 두지 않으면 영영 없다.
 *
 * ## 키가 머무는 곳 (R1)
 *
 * - **이 컴포넌트를 그리는 쪽의 상태에만** 있다. `pendingWorkspace`(localStorage)·영속 store 에 넣지 않는다 —
 *   이어받기용 보관본은 클레임 토큰만 든다. 앱을 닫으면 사라지는 것이 맞다.
 * - 로그로 내보내지 않는다(이 파일에 console 호출이 없다). desktop 에는 에러 리포터·쿼리 캐시가 없다.
 * - [복사]는 Rust 명령(`writeConcealed`)으로 한다: 클립보드 기록 앱용 감춤 표지를 붙이고, 60초 뒤 그 사이
 *   클립보드가 바뀌지 않았을 때만 비운다. 웹뷰는 키를 들고 기다리지 않는다. 그 명령이 없으면(macOS 밖·웹)
 *   일반 복사로 물러나고 "비운다"고 말하지 않는다 — 하지 않는 일을 약속하지 않는다.
 * - [파일로 저장]은 Blob 을 이 자리에서 만든다 — 서버를 다시 거치지 않는다.
 * - 클립보드 기록·기기 간 동기화에 사본이 남을 수 있다는 한 줄을 화면에 적는다.
 */
export function RecoveryKeyStep({ recoveryKey, communityName, onDone }: {
  recoveryKey: string;
  communityName: string;
  onDone(): void;
}) {
  const t = useT();
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const keyRef = useRef<HTMLElement | null>(null);

  const copy = async () => {
    if (await writeConcealed(recoveryKey)) {
      setNote(t('connect.recovery.copiedConcealed'));
      return;
    }
    const outcome = await copyText(recoveryKey, keyRef.current);
    if (outcome === 'copied') {
      setNote(t('connect.recovery.copied'));
    } else if (outcome === 'selected') {
      setNote(t('connect.recovery.selected'));
    } else {
      setNote(t('connect.recovery.copyFailed'));
    }
  };

  const saveFile = () => {
    const blob = new Blob([`${recoveryKey}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const filename = `harkroom-recovery-key-${communityName}.txt`;
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      // WKWebView 는 저장창 없이 Downloads 에 바로 쓴다 — 평문 파일이 남았다는 것을 말해 준다.
      setNote(t('connect.recovery.savedFile', { filename }));
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  };

  return (
    <div className="space-y-3" data-testid="recovery-key-step">
      <p className="text-fg font-medium">{t('connect.recovery.title')}</p>
      <p className="break-keep text-meta text-fg-subtle">
        {t('connect.recovery.introBefore')}<span className="font-semibold">{t('connect.recovery.introOnce')}</span>{t('connect.recovery.introAfter')}
      </p>
      <code
        ref={keyRef}
        data-testid="recovery-key-value"
        className="block select-all break-all rounded-row border border-border bg-field px-3 py-2 font-mono text-meta text-fg"
      >
        {recoveryKey}
      </code>
      <div className="flex gap-2">
        <button type="button" className="flex-1 rounded-row border border-border py-1.5 text-meta hover:bg-surface" onClick={() => { void copy(); }}>
          {t('connect.recovery.copy')}
        </button>
        <button type="button" className="flex-1 rounded-row border border-border py-1.5 text-meta hover:bg-surface" onClick={saveFile}>
          {t('connect.recovery.saveFile')}
        </button>
      </div>
      {note && <p className="text-meta text-fg-subtle" role="status">{note}</p>}
      <p className="break-keep text-meta text-fg-subtle">{t('connect.recovery.clipboardNote')}</p>
      <label className="flex items-start gap-2 text-meta">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>{t('connect.recovery.confirm')}</span>
      </label>
      <button
        type="button"
        disabled={!saved}
        onClick={onDone}
        className="w-full rounded-row bg-accent py-2 font-medium text-fg-on-strong disabled:opacity-50"
      >
        {t('connect.recovery.continue')}
      </button>
    </div>
  );
}
