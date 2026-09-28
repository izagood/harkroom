import { useEffect, useState } from 'react';
import type { AgentDefaults } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { Button, Field, Segmented, Select, SettingsGroup, SettingsPage, TextInput } from './primitives';
import { useT } from '../../i18n/useT';

/** 러너가 실제로 띄울 수 있는 하네스. `AgentsSettings` 와 같은 목록이어야 한다. */
const RUNNABLE_HARNESSES = ['claude-code', 'codex'] as const;
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
  // **세 상태다**(#171): null(아직 안 읽음) / 'error'(못 읽음) / 값.
  // 셋을 구별하지 않으면 "불러오는 중"과 "못 불러왔다"가 같은 빈 화면이 된다.
  const [defaults, setDefaults] = useState<AgentDefaults | 'error' | null>(null);
  const [form, setForm] = useState<{ harness: string; model: string; effort: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // admin 전용 라우트다(`GET /settings/agent-defaults`). admin 이 아닌 사람에게 부르면 403 이
  // 나고, 그 403 을 오류로 그리면 아무 잘못도 없는 화면에 붉은 글이 뜬다.
  useEffect(() => {
    if (!isAdmin) return;
    void getController().agentDefaults()
      .then((d) => {
        setDefaults(d);
        setForm({ harness: d.harness, model: d.model ?? '', effort: d.effort ?? '' });
      })
      .catch(() => setDefaults('error'));
  }, [isAdmin]);

  const save = async (): Promise<void> => {
    if (!form) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await getController().updateAgentDefaults({
        harness: form.harness,
        // 빈 문자열은 '지우기'다 — **명시적 null 로 보낸다.** undefined 로 보내면
        // JSON.stringify 가 그 키를 통째로 버려 '손대지 않음'이 되고, 지우려는 조작이
        // 조용히 무시된다.
        model: form.model || null,
        effort: form.effort || null,
      });
      setDefaults(next);
      setForm({ harness: next.harness, model: next.model ?? '', effort: next.effort ?? '' });
      setSaved(true);
    } catch {
      setError(t('defaults.field.saveFailed'));
    } finally { setBusy(false); }
  };

  return (
    <SettingsPage
      title="Agent defaults"
      description={t('defaults.field.subtitle')}
    >
      <SettingsGroup>
        {!isAdmin && (
          // 권한이 없는 것은 오류가 아니다 — 붉게 그리지 않는다.
          // 크기를 안 적어 본문단 13px 을 물려받는다: 이 세 줄은 각자 그 순간 화면의
          // **내용 전부**이므로(권한 없음·대기·실패) 아랫단으로 내리면 화면 하나가 통째로
          // 가장 작은 글자가 된다. 아래 폼이 뜨는 정상 경로에서는 라벨이 아랫단이다.
          <p className="text-fg-muted">{t('defaults.field.notAdmin')}</p>
        )}
        {isAdmin && defaults === null && <p className="text-fg-muted">{t('defaults.field.loading')}</p>}
        {isAdmin && defaults === 'error' && (
          <p role="alert" className="text-danger">{t('defaults.field.loadFailed')}</p>
        )}
        {isAdmin && form && defaults !== 'error' && (
          <div className="max-w-md space-y-3">
            {/* 하네스는 둘뿐이라 펼치지 않고 전부 보인다 — 고르기 전에 무엇이 있는지 안다. */}
            <Field label={t('defaults.field.harness')}>
              <Segmented
                label={t('defaults.field.harness')}
                value={form.harness}
                onChange={(v) => { setForm({ ...form, harness: v }); setSaved(false); }}
                options={RUNNABLE_HARNESSES.map((h) => ({ value: h, label: h }))}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('defaults.field.model')} hint={t('defaults.field.modelHint')}>
                <TextInput
                  ariaLabel={t('defaults.field.model')}
                  placeholder={t('defaults.field.harnessDefault')}
                  value={form.model}
                  onChange={(v) => { setForm({ ...form, model: v }); setSaved(false); }}
                />
              </Field>
              <Field label={t('defaults.field.effort')}>
                <Select
                  ariaLabel={t('defaults.field.effort')}
                  value={form.effort}
                  onChange={(v) => { setForm({ ...form, effort: v }); setSaved(false); }}
                  options={[{ value: '', label: t('defaults.field.harnessDefault') }, ...EFFORTS.map((e) => ({ value: e, label: e }))]}
                />
              </Field>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="primary" disabled={busy} onClick={() => void save()}>
                {t('defaults.field.save')}
              </Button>
              {saved && <span className="text-meta text-success">{t('defaults.field.saved')}</span>}
              {error && <span role="alert" className="text-meta text-danger">{error}</span>}
            </div>
            <p className="text-meta text-fg-muted">
              {t('defaults.field.applyScope')}
            </p>
          </div>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
