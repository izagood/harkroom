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
        <div className="flex gap-1 p-1">
          {COLOR_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              role="radio"
              aria-checked={colorMode === option.value}
              aria-label={`${option.label} appearance`}
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition
                ${colorMode === option.value
                  ? 'bg-accent text-white'
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