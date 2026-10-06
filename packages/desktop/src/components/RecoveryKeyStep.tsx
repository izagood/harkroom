import { useRef, useState } from 'react';
import { copyText } from '../lib/clipboard';

/** 복사한 복구 키를 클립보드에서 지우기까지의 시간. */
export const RECOVERY_CLIPBOARD_CLEAR_MS = 60_000;

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
 * - [복사]는 60초 뒤 클립보드가 **아직 이 값이면** 지운다. 그 사이 사람이 다른 것을 복사했으면 건드리지
 *   않는다. 클립보드를 읽을 수 없으면 지우지 않는다(남의 클립보드를 덮을 수 있다).
 * - [파일로 저장]은 Blob 을 이 자리에서 만든다 — 서버를 다시 거치지 않는다.
 * - 클립보드 기록·기기 간 동기화에 사본이 남을 수 있다는 한 줄을 화면에 적는다.
 */
export function RecoveryKeyStep({ recoveryKey, communityName, onDone }: {
  recoveryKey: string;
  communityName: string;
  onDone(): void;
}) {
  const [saved, setSaved] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const keyRef = useRef<HTMLElement | null>(null);

  const copy = async () => {
    const outcome = await copyText(recoveryKey, keyRef.current);
    if (outcome === 'copied') {
      setNote('Copied. The clipboard will be cleared in 60 seconds.');
      scheduleClipboardClear(recoveryKey);
    } else if (outcome === 'selected') {
      setNote('Selected — press ⌘C to copy.');
    } else {
      setNote('Could not copy. Select the key and copy it by hand.');
    }
  };

  const saveFile = () => {
    const blob = new Blob([`${recoveryKey}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = `harkroom-recovery-key-${communityName}.txt`;
      a.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  };

  return (
    <div className="space-y-3" data-testid="recovery-key-step">
      <p className="text-fg font-medium">Save your recovery key</p>
      <p className="text-meta text-fg-subtle">
        This key restores the community&apos;s secret vault if the hosting service ever has to be rebuilt.
        It is shown <b>only once</b> — nobody, including the operator, keeps a copy.
      </p>
      <code
        ref={keyRef}
        data-testid="recovery-key-value"
        className="block select-all break-all rounded-row border border-border bg-field px-3 py-2 font-mono text-meta text-fg"
      >
        {recoveryKey}
      </code>
      <div className="flex gap-2">
        <button type="button" className="flex-1 rounded-row border border-border py-1.5 text-meta" onClick={() => { void copy(); }}>
          Copy
        </button>
        <button type="button" className="flex-1 rounded-row border border-border py-1.5 text-meta" onClick={saveFile}>
          Save to file
        </button>
      </div>
      {note && <p className="text-meta text-fg-subtle" role="status">{note}</p>}
      <p className="text-meta text-fg-subtle">
        Copies can stay in clipboard history or sync to your other devices. A password manager is a good place for it.
      </p>
      <label className="flex items-start gap-2 text-meta">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I saved the recovery key somewhere safe.</span>
      </label>
      <button
        type="button"
        disabled={!saved}
        onClick={onDone}
        className="w-full rounded-row bg-accent py-2 font-medium text-fg-on-strong disabled:opacity-50"
      >
        Continue
      </button>
    </div>
  );
}

/**
 * 60초 뒤 클립보드가 아직 그 키면 비운다. 화면을 떠나도 돈다(타이머를 컴포넌트에 묶지 않는다) — 사람은 대개
 * 복사하자마자 다음으로 넘어간다.
 */
function scheduleClipboardClear(value: string): void {
  setTimeout(() => {
    void (async () => {
      try {
        if (!navigator.clipboard?.readText) return;
        if ((await navigator.clipboard.readText()) === value) await navigator.clipboard.writeText('');
      } catch { /* 읽을 수 없으면 지우지 않는다 */ }
    })();
  }, RECOVERY_CLIPBOARD_CLEAR_MS);
}
