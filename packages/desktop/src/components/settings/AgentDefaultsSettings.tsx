import { useEffect, useState } from 'react';
import { RUNNABLE_HARNESSES, type AgentDefaults } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { Field, SaveStatus, Segmented, Select, SettingsColumns, SettingsGroup, SettingsPage, TextInput, type SaveState } from './primitives';
import { useT } from '../../i18n/useT';

// 러너가 실제로 띄울 수 있는 하네스는 `@harkroom/shared` 의 `RUNNABLE_HARNESSES` 하나다. 여기에
// 따로 적어 뒀더니 opencode 가 열린 뒤에도 이 화면엔 claude-code·codex 만 남았다(2026-10-01, kilo 를 열며 발견).
const EFFORTS = ['low', 'medium', 'high'] as const;

/**
 * 워크스페이스의 **새 에이전트 기본값**(#171 · identity 문서 원칙 04).
 *
 * `AgentsSettings` 의 Add agent 폼 안에 있던 것을 여기로 옮겼다. **개별 에이전트의 설정이
 * 아니기 때문이다** — 문서가 "이 화면 위계 혼란의 대부분이 여기서 나온다"고 적은 자리다.
 * 한 에이전트를 고치는 화면 안에 워크스페이스 전체에 걸리는 값이 앉아 있으면, 지금 무엇을
 * 고치고 있는지가 화면에서 사라진다.
 *
 * **여기서 정한 값은 다음에 만들 에이전트에 복사된다** — 이미 있는 에이전트는 하나도
 * 바뀌지 않는다. 참조가 아니라 복사인 이유: harness 는 러너가 매 턴 읽어 프로세스를 띄우는
 * 값이라, 참조로 두면 기본값을 고치는 순간 돌고 있는 에이전트의 하네스가 중간에 바뀐다.
 */
export function AgentDefaultsSettings() {
  const t = useT();
  const isAdmin = useActiveStore((s) => s.me?.isAdmin === true);
  const [defaults, setDefaults] = useState<AgentDefaults | 'error' | null>(null);
  const [form, setForm] = useState<{ harness: string; model: string; effort: string } | null>(null);
  const [state, setState] = useState<SaveState>('idle');

  useEffect(() => {
    if (!isAdmin) return;
    void getController().agentDefaults()
      .then((d) => {
        setDefaults(d);
        setForm({ harness: d.harness, model: d.model ?? '', effort: d.effort ?? '' });
      })
      .catch(() => setDefaults('error'));
  }, [isAdmin]);

  /**
   * **바꾸면 바로 저장한다**(UX ⑤ M1). 이 탭만 [기본값 저장] 을 따로 눌러야 했다 — 다른 설정은
   * 누르는 즉시 적용되니, 사람은 여기서도 그런 줄 알고 떠나 바꾼 값을 잃었다. 하네스·Effort 는
   * 고르는 순간, 모델 이름은 칸을 떠날 때(또는 Enter) 저장한다 — 글자마다 저장하면 반쯤 친
   * 모델 이름이 기본값으로 선다.
   */
  const commit = async (next: { harness: string; model: string; effort: string }): Promise<void> => {
    setForm(next);
    setState('saving');
    try {
      const saved = await getController().updateAgentDefaults({
        harness: next.harness,
        model: next.model.trim() || null,
        effort: next.effort || null,
      });
      setDefaults(saved);
      setForm({ harness: saved.harness, model: saved.model ?? '', effort: saved.effort ?? '' });
      setState('saved');
    } catch {
      setState('failed');
    }
  };
  const commitModel = (): void => {
    if (!form || defaults === null || defaults === 'error') return;
    if (form.model.trim() === (defaults.model ?? '')) return;
    void commit(form);
  };

  return (
    <SettingsPage
      section="agent-defaults"
      description={t('defaults.field.subtitle')}
      layout="cards"
    >
      {/* 새 에이전트 기본값 한 칸이다. 곁 칸이던 멘션 연쇄 상한은 없다 — 홉 수로 부름을 막던 검사를 서버에서 걷었다. */}
      <SettingsColumns
        testId="agent-defaults-columns"
        main={(
      <SettingsGroup>
        {!isAdmin && (
          <p className="px-4 py-3 text-fg-muted">{t('defaults.field.notAdmin')}</p>
        )}
        {isAdmin && defaults === null && <p className="px-4 py-3 text-fg-muted">{t('defaults.field.loading')}</p>}
        {isAdmin && defaults === 'error' && (
          <p role="alert" className="px-4 py-3 text-danger">{t('defaults.field.loadFailed')}</p>
        )}
        {isAdmin && form && defaults !== 'error' && (
          // 안쪽 여백(`px-4 py-3`)은 다른 설정 묶음의 줄과 같다 — 라벨이 카드 테두리에 붙어
          // 있었다(M1).
          <div className="space-y-3 px-4 py-3">
            {/* 하네스는 몇 개뿐이라 펼치지 않고 전부 보인다 — 고르기 전에 무엇이 있는지 안다.
                목록은 shared 의 `RUNNABLE_HARNESSES`(서버 검증과 같은 목록)다 — 이 화면이
                제 목록을 따로 들고 있어 opencode 가 빠져 있었다(M1). */}
            <Field label={t('defaults.field.harness')}>
              <Segmented
                label={t('defaults.field.harness')}
                value={form.harness}
                onChange={(v) => void commit({ ...form, harness: v })}
                options={RUNNABLE_HARNESSES.map((h) => ({ value: h, label: h }))}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('defaults.field.model')} hint={t('defaults.field.modelHint')}>
                <span onBlur={commitModel} onKeyDown={(e) => { if (e.key === 'Enter') commitModel(); }}>
                  <TextInput
                    ariaLabel={t('defaults.field.model')}
                    placeholder={t('defaults.field.harnessDefault')}
                    value={form.model}
                    onChange={(v) => { setForm({ ...form, model: v }); setState('idle'); }}
                  />
                </span>
              </Field>
              <Field label={t('defaults.field.effort')}>
                <Select
                  ariaLabel={t('defaults.field.effort')}
                  value={form.effort}
                  onChange={(v) => void commit({ ...form, effort: v })}
                  options={[{ value: '', label: t('defaults.field.harnessDefault') }, ...EFFORTS.map((e) => ({ value: e, label: e }))]}
                />
              </Field>
            </div>
            {/* 부제가 이미 "이미 있는 에이전트는 바뀌지 않는다" 를 말한다 — 같은 문장이 위아래로
                두 번 서 있었다(M1). */}
            <SaveStatus state={state} failedLabel={t('defaults.field.saveFailed')} />
          </div>
        )}
      </SettingsGroup>
        )}
      />
    </SettingsPage>
  );
}

