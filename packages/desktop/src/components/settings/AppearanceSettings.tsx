import { usePrefsStore } from '../../state/prefsStore';
import { SettingsGroup, SettingsPage } from './primitives';
import type { ColorMode } from '../../lib/prefs';

const COLOR_MODE_OPTIONS: { value: ColorMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function AppearanceSettings() {
  const colorMode = usePrefsStore((s) => s.colorMode);
  const setColorMode = usePrefsStore((s) => s.setColorMode);

  return (
    <SettingsPage
      title="Appearance"
      description="Follow your system or choose a light or dark appearance"
    >
      <SettingsGroup title="Color mode">
        {/*
          `radiogroup` 이 있어야 스크린리더가 "셋 중 하나를 고르는 자리"라고 말한다.
          라디오 셋을 그냥 나열하면 각각이 독립 토글처럼 읽혀, 하나를 켜면 다른 하나가
          꺼진다는 것을 화면 밖에서는 알 수 없다.
        */}
        <div role="radiogroup" aria-label="Color mode" className="flex gap-1 p-1">
          {COLOR_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              role="radio"
              aria-checked={colorMode === option.value}
              aria-label={`${option.label} appearance`}
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition
                ${colorMode === option.value
                  ? 'bg-accent text-fg-on-strong'
                  : 'bg-surface-raised text-fg hover:bg-surface'
                }`}
              onClick={() => setColorMode(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}