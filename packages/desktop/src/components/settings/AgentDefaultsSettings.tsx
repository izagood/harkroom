import { useEffect, useState } from 'react';
import type { AgentDefaults } from '@murmur/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { SettingsGroup, SettingsPage } from './primitives';

/** 러너가 실제로 띄울 수 있는 하네스. `AgentsSettings` 와 같은 목록이어야 한다. */
const RUNNABLE_HARNESSES = ['claude-code', 'codex'] as const;
const EFFORTS = ['low', 'medium', 'high'] as const;

const label = 'block text-xs font-medium text-fg-muted';
const field = 'mt-1 w-full rounded border border-border bg-field px-2 py-1 text-sm';

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
      setError('기본값을 저장하지 못했다');
    } finally { setBusy(false); }
  };

  return (
    <SettingsPage
      title="Agent defaults"
      description="새로 만드는 에이전트가 물려받을 값. 이미 있는 에이전트는 바뀌지 않는다."
    >
      <SettingsGroup>
        {!isAdmin && (
          // 권한이 없는 것은 오류가 아니다 — 붉게 그리지 않는다.
          <p className="text-xs text-fg-muted">기본값을 정할 수 있는 것은 admin 뿐이다.</p>
        )}
        {isAdmin && defaults === null && <p className="text-xs text-fg-muted">불러오는 중…</p>}
        {isAdmin && defaults === 'error' && (
          <p role="alert" className="text-xs text-danger">기본값을 불러오지 못했다</p>
        )}
        {isAdmin && form && defaults !== 'error' && (
          <div className="max-w-md space-y-3">
            <label className={label}>
              기본 harness
              <select
                className={field}
                aria-label="기본 harness"
                value={form.harness}
                onChange={(e) => { setForm({ ...form, harness: e.target.value }); setSaved(false); }}
              >
                {RUNNABLE_HARNESSES.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className={label}>
                기본 model
                <input
                  className={field}
                  aria-label="기본 model"
                  placeholder="harness 기본값"
                  value={form.model}
                  onChange={(e) => { setForm({ ...form, model: e.target.value }); setSaved(false); }}
                />
              </label>
              <label className={label}>
                기본 effort
                <select
                  className={field}
                  aria-label="기본 effort"
                  value={form.effort}
                  onChange={(e) => { setForm({ ...form, effort: e.target.value }); setSaved(false); }}
                >
                  <option value="">harness 기본값</option>
                  {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
                </select>
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="rounded bg-accent px-3 py-1 text-xs font-medium text-fg-on-strong
                           hover:bg-accent-hover disabled:opacity-50"
                disabled={busy}
                onClick={() => void save()}
              >
                기본값 저장
              </button>
              {saved && <span className="text-[11px] text-success">저장했다</span>}
              {error && <span role="alert" className="text-[11px] text-danger">{error}</span>}
            </div>
            <p className="text-[11px] text-fg-muted">
              다음에 만드는 에이전트에만 적용된다. 이미 있는 에이전트는 바뀌지 않는다.
            </p>
          </div>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}
