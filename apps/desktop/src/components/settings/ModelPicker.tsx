/**
 * 모델 고르개 — 하네스가 **실제로 받는다고 밝힌** 모델에서 고른다.
 *
 * 목록은 그 에이전트를 돌리는 오퍼레이터가 능력(`capabilities.harnesses[h].models`)으로 올린
 * 것이다(`operator/src/harnessModels.ts`). 세 상태를 구별한다:
 * - `null`: 아직 안 읽음 — 고르개를 잠근다.
 * - `undefined`: 모른다(오프라인·옛 오퍼레이터·권한 없음·하네스가 목록을 못 줌) — 옛 자유
 *   입력으로 물러선다. "고를 것이 없다" 고 그리면 사람은 모델을 못 바꾼다고 믿는다.
 * - 배열: 그 안에서 고른다. 목록 밖의 이름(별칭의 전체 이름 등)을 위해 **직접 입력** 을 남긴다.
 *
 * 저장된 값이 목록에 없으면 직접 입력으로 연다 — 조용히 목록의 첫 값으로 바꾸지 않는다.
 */
import { useState } from 'react';
import type { HarnessModel } from '@harkroom/shared';
import { useT } from '../../i18n/useT';

const CUSTOM = '__custom__';

export function ModelPicker({ value, models, onChange, className }: {
  value: string;
  models: HarnessModel[] | undefined | null;
  onChange: (next: string) => void;
  className: string;
}) {
  const t = useT();
  const listed = Array.isArray(models) && models.some((m) => m.id === value);
  const [custom, setCustom] = useState(false);
  const showCustom = models === undefined || custom || (value !== '' && !listed && models !== null);

  const input = (
    <input
      className={className}
      // 고르개와 같이 설 때는 이름이 겹치지 않게 한다 — 둘 다 'Model' 이면 라벨로 집을 수 없다.
      aria-label={models === undefined ? 'Model' : 'Model name'}
      data-testid="model-custom-input"
      placeholder={t('agents.run.harnessDefault')}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
  if (models === undefined) {
    return (
      <>
        {input}
        <span className="text-meta text-fg-subtle" data-testid="model-list-unknown">{t('agents.model.listUnknown')}</span>
      </>
    );
  }
  return (
    <>
      <select
        className={className}
        aria-label="Model"
        data-testid="model-select"
        disabled={models === null}
        value={showCustom ? CUSTOM : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM) { setCustom(true); return; }
          setCustom(false);
          onChange(e.target.value);
        }}
      >
        <option value="">{t('agents.run.harnessDefault')}</option>
        {(models ?? []).map((m) => (
          <option key={m.id} value={m.id}>{m.label && m.label !== m.id ? `${m.label} — ${m.id}` : m.id}</option>
        ))}
        <option value={CUSTOM}>{t('agents.model.custom')}</option>
      </select>
      {showCustom && input}
    </>
  );
}
