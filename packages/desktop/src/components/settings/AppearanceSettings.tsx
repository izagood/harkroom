import { usePrefsStore } from '../../state/prefsStore';
import { SettingsGroup, SettingsPage } from './primitives';
import type { ColorMode } from '../../lib/prefs';
import { DEFAULT_ZOOM, ZOOM_STEPS } from '../../lib/zoom';
import { LOCALES, LOCALE_NAMES } from '../../i18n';
import { useT } from '../../i18n/useT';

/**
 * 색 모드 셋. **값은 저장·전송용이라 옮기지 않고**, 사람에게 보이는 이름만 사전을 지난다
 * (`sidebar.notify` 가 `all`/`mentions`/`none` 을 안 옮긴 것과 같은 규칙).
 *
 * 값이 **키가 아니라 값 자체**인 이유: 이 표는 언어가 아니라 `ColorMode` 의 집합을 정한다.
 * 이름은 아래에서 `t()` 가 붙인다.
 */
const COLOR_MODES: ColorMode[] = ['system', 'light', 'dark'];

/** 그 언어의 이름을 그 언어로. `System` 만 지금 언어를 따른다 — 그것은 언어가 아니라 **결정**이다. */
const MODE_NAME: Record<ColorMode, string> = { system: 'System', light: 'Light', dark: 'Dark' };

export function AppearanceSettings() {
  const t = useT();
  const colorMode = usePrefsStore((s) => s.colorMode);
  const setColorMode = usePrefsStore((s) => s.setColorMode);
  const locale = usePrefsStore((s) => s.locale);
  const setLocale = usePrefsStore((s) => s.setLocale);
  const zoom = usePrefsStore((s) => s.zoom);
  const setZoom = usePrefsStore((s) => s.setZoom);

  const pill = (on: boolean) => `flex-1 rounded-lg py-2 font-medium transition ${
    on ? 'bg-accent text-fg-on-strong' : 'bg-surface-raised text-fg hover:bg-surface'
  }`;

  return (
    <SettingsPage title={t('appearance.title')} description={t('appearance.description')}>
      <SettingsGroup title={t('appearance.colorMode')}>
        {/*
          `radiogroup` 이 있어야 스크린리더가 "셋 중 하나를 고르는 자리"라고 말한다.
          라디오 셋을 그냥 나열하면 각각이 독립 토글처럼 읽혀, 하나를 켜면 다른 하나가
          꺼진다는 것을 화면 밖에서는 알 수 없다.
        */}
        <div role="radiogroup" aria-label={t('appearance.colorMode')} className="flex gap-1 p-1">
          {COLOR_MODES.map((mode) => (
            <button
              key={mode}
              role="radio"
              aria-checked={colorMode === mode}
              aria-label={t('appearance.mode', { mode: MODE_NAME[mode] })}
              className={pill(colorMode === mode)}
              onClick={() => setColorMode(mode)}
            >
              {MODE_NAME[mode]}
            </button>
          ))}
        </div>
      </SettingsGroup>

      {/*
        **언어 고르개.** 값과 배선은 진작 있었는데(`prefs.locale`·`setLocale`) 고를 자리가
        없어서 사람이 언어를 바꿀 방법이 없었다 — i18n 작업이 끝나도 그 상태로는 반쪽이다.

        언어 이름은 **사전을 안 지난다**: `LOCALE_NAMES` 가 각 언어를 그 언어로 적고 있고
        (`English` · `한국어`), 그것이 옳다. 사전에 넣으면 지금 언어로 번역되어 영어 화면에서
        `Korean` 이 되고, 그러면 **한국어를 찾는 사람이 자기 언어를 못 찾는다.**

        `System` 만 예외다 — 그것은 언어가 아니라 *"내가 안 고르겠다"* 는 결정이라 지금
        언어로 말해야 한다.
      */}
      <SettingsGroup title={t('appearance.language')}>
        <div role="radiogroup" aria-label={t('appearance.language')} className="flex gap-1 p-1">
          <button
            role="radio"
            aria-checked={locale === 'system'}
            className={pill(locale === 'system')}
            onClick={() => setLocale('system')}
          >
            {t('appearance.languageSystem')}
          </button>
          {LOCALES.map((code) => (
            <button
              key={code}
              role="radio"
              aria-checked={locale === code}
              aria-label={t('appearance.languageOption', { name: LOCALE_NAMES[code] })}
              className={pill(locale === code)}
              onClick={() => setLocale(code)}
            >
              {LOCALE_NAMES[code]}
            </button>
          ))}
        </div>
      </SettingsGroup>

      {/*
        **확대/축소.** 글자만 키우는 손잡이를 두지 않는 이유는 `lib/zoom.ts` 의 첫 주석에
        있다 — 이 앱의 여백·패널 폭은 px 라 글자만 커지면 밀도가 무너진다. 여기서 고르는
        것은 화면 전체의 배율이다.

        칸을 가로 한 줄이 아니라 3×3 으로 세운다: 아홉이 한 줄에 서면 칸마다 65px 이라
        `125%` 가 이미 빠듯하고, 배율을 올린 사람의 화면에서는 그 줄이 제일 먼저 넘친다 —
        배율을 되돌리러 온 자리가 배율 때문에 깨져 있으면 빠져나올 길이 없다.
      */}
      <SettingsGroup title={t('appearance.zoom')}>
        <div role="radiogroup" aria-label={t('appearance.zoom')} className="grid grid-cols-3 gap-1 p-1">
          {ZOOM_STEPS.map((step) => (
            <button
              key={step}
              role="radio"
              aria-checked={zoom === step}
              aria-label={t('appearance.zoomOption', { percent: String(step) })}
              className={pill(zoom === step)}
              onClick={() => setZoom(step)}
            >
              {step}%
              {/*
                기본값이 어느 칸인지 화면에 적는다. 배율은 눈으로 되돌리기 어려운 설정이라
                (지금이 110% 인지 125% 인지는 화면만 봐서 모른다) "원래 자리" 가 보여야 한다.
              */}
              {step === DEFAULT_ZOOM && (
                <span className="ml-1 font-normal opacity-70">{t('appearance.zoomDefault')}</span>
              )}
            </button>
          ))}
        </div>
        <p className="px-4 py-3 text-meta text-fg-muted">{t('appearance.zoomHint')}</p>
      </SettingsGroup>
    </SettingsPage>
  );
}
