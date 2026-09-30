/**
 * 풀별 **계정 배정 기준**(2026-09-29 C ③). 러너는 새 스레드를 이 풀의 계정 가운데 주간 여유가
 * 가장 빨리 사라질 계정부터 나눠 주고(`agent/src/accountAssign.ts`), 여기 적힌 % 이상인 계정은
 * 새로 배정하지 않는다. 이미 배정된 스레드는 옮기기 기준을 넘을 때만 옮긴다 — 옮기면 세션을 잃는다.
 *
 * 값은 `pools.json` 의 `assign[풀]` 이다. 빈 칸은 기본값(85/97·95/98)이고, 기본값과 같은 칸은
 * 파일에 적지 않는다 — 기본값이 바뀌면 사람이 손대지 않은 풀은 새 기본을 따라야 한다.
 */
import { useState } from 'react';

import {
  DEFAULT_ASSIGN_THRESHOLDS,
  resolveAssignThresholds,
  type ClaudeAssignThresholds,
  type ClaudePoolsConfig,
} from '@harkroom/shared/claudePools';

import { Button, TextInput } from './primitives';

const FIELDS: { key: keyof ClaudeAssignThresholds; label: string }[] = [
  { key: 'newSessionPct', label: 'Skip for new threads at 5-hour %' },
  { key: 'newWeeklyPct', label: 'Skip for new threads at weekly %' },
  { key: 'moveSessionPct', label: 'Move a thread at 5-hour %' },
  { key: 'moveWeeklyPct', label: 'Move a thread at weekly %' },
];

export function ClaudeAssignThresholdsRow({ pool, assign, onSave }: {
  pool: string;
  assign: NonNullable<ClaudePoolsConfig['assign']>;
  onSave(next: Partial<ClaudeAssignThresholds>): Promise<void>;
}) {
  const current = resolveAssignThresholds({ defaultPool: null, order: {}, agents: {}, assign }, pool);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const parsed = FIELDS.map((f) => {
    const n = Number(draft[f.key]);
    return { ...f, n, ok: Number.isFinite(n) && n >= 1 && n <= 100 };
  });
  const allOk = parsed.every((p) => p.ok);

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-meta text-fg-muted" data-testid={`claude-assign-${pool}`}>
        <span>
          New threads skip an account at {current.newSessionPct}% (5-hour) or {current.newWeeklyPct}% (weekly).
          {' '}A thread moves at {current.moveSessionPct}% or {current.moveWeeklyPct}%.
        </span>
        <Button ariaLabel={`Edit assignment limits for ${pool}`} onClick={() => {
          setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, String(current[f.key])])));
          setEditing(true);
        }}>Edit limits</Button>
      </div>
    );
  }
  return (
    <div className="px-4 py-3" data-testid={`claude-assign-${pool}`}>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {parsed.map((p) => (
          <label key={p.key} className="flex items-center justify-between gap-2 text-meta text-fg-muted">
            <span>{p.label}</span>
            <span className="w-20">
              <TextInput
                ariaLabel={`${p.label} (${pool})`}
                value={draft[p.key] ?? ''}
                onChange={(v) => setDraft((d) => ({ ...d, [p.key]: v }))}
              />
            </span>
          </label>
        ))}
      </div>
      {!allOk && <div className="mt-2 text-meta text-warning">Use whole percentages from 1 to 100.</div>}
      <div className="mt-3 flex gap-2">
        <Button
          variant="primary"
          disabled={!allOk}
          onClick={async () => {
            // 기본값과 같은 칸은 적지 않는다(파일 머리말).
            const next: Partial<ClaudeAssignThresholds> = {};
            for (const p of parsed) if (p.n !== DEFAULT_ASSIGN_THRESHOLDS[p.key]) next[p.key] = p.n;
            await onSave(next);
            setEditing(false);
          }}
        >
          Save
        </Button>
        <Button onClick={() => setEditing(false)}>Cancel</Button>
      </div>
    </div>
  );
}
