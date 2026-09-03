import { useState } from 'react';
import { undoSendStorage } from '../../lib/prefs';
import { SettingsGroup, SettingsPage } from './primitives';

/**
 * 고를 수 있는 창 길이(초). 자유 입력이 아닌 이유는, 초 단위로 아무 값이나 넣을 이유가
 * 없는 반면 "0 이면 끈다"를 사람이 알아차릴 자리는 필요하기 때문이다.
 */
const CHOICES = [0, 5_000, 10_000, 30_000];

/**
 * 보냄 취소 창의 길이를 고르는 자리(#223).
 *
 * 계정이 아니라 **기기 로컬**이다 — `design.md` 의 "값은 전부 기기 로컬이다" 원칙. 얼마나
 * 기다릴지는 이 기기에서 일하는 방식이라 서버가 알 이유가 없다.
 */
export function MessageSettings() {
  // 저장소를 한 번만 읽고 지역 state 로 끌고 간다. 이 값을 읽는 곳은 컴포저이고, 컴포저는
  // 전송할 때마다 저장소를 다시 읽으므로 여기서 전역 스토어를 늘릴 이유가 없다.
  const [windowMs, setWindowMs] = useState(() => undoSendStorage.loadWindowMs());

  const choose = (ms: number): void => {
    undoSendStorage.saveWindowMs(ms);
    setWindowMs(ms);
  };

  return (
    <SettingsPage
      title="Messages"
      description="These choices live on this device only."
    >
      <SettingsGroup title="Undo send">
        <div className="px-4 py-3">
          <p className="font-medium text-fg">Hold a message before it goes out</p>
          <p className="mt-0.5 text-fg-subtle">
            murmur keeps the message on this device for that long. Undo it and nothing was ever
            sent — no message, no mention, no agent woken. Once the window closes there is no
            way back.
          </p>
          <div className="mt-3 flex gap-2">
            {CHOICES.map((ms) => (
              <button
                key={ms}
                type="button"
                aria-pressed={windowMs === ms}
                className={`rounded-lg border px-3 py-1 ${
                  windowMs === ms
                    ? 'border-accent bg-accent-surface font-medium text-accent'
                    : 'border-border text-fg hover:bg-surface'
                }`}
                onClick={() => choose(ms)}
              >
                {ms === 0 ? 'Off' : `${ms / 1000}s`}
              </button>
            ))}
          </div>
          {windowMs === 0 && (
            <p data-testid="undo-send-off" className="mt-2 text-fg-subtle">
              Off sends every message the moment you press Enter.
            </p>
          )}
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}
