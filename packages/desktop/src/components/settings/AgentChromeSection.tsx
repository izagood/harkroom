/**
 * 에이전트별 **Claude in Chrome** 연동(스레드 e8c8365d). 켜면 그 에이전트의 claude 턴에만 러너가 `--chrome` 을
 * 붙인다 — 그 밖에는 늘 `--no-chrome` 이다(agent `turn.ts::chromeTurnFor`).
 *
 * 열리는지는 **세 곳이 같이** 정한다. 이 화면은 그 셋을 사람 말로 보일 뿐 판정을 복사하지 않는다:
 * - 서버 값 `chromeEnabled`(이 스위치). 켜기는 사람의 로그인 세션만 받는다(403 `human_session_required`).
 * - 러너: 읽기 전용 에이전트는 값과 상관없이 닫는다.
 * - 오퍼레이터 기계: `OperatorCapabilities.chrome` — 앱이 띄운 로컬 오퍼레이터이고 확장이 있어야 `available`.
 *
 * 켜는 쪽만 막는다. 끄기는 언제나 된다 — 기계가 사라졌거나 읽기 전용이 된 뒤에도 남은 켜짐을 지울 수 있어야 한다.
 * 켤 때는 경고를 한 번 더 읽힌다(security n2: 로그인된 모든 사이트·웹 글의 지시 주입·사람이 없어도 돈다).
 */
import { useEffect, useRef, useState } from 'react';
import type { AgentView, ChromeHostState } from '@harkroom/shared';
import { getController } from '../../state/controller';
import { ApiError } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { errorText } from '../../lib/errorText';
import { ImmediateBadge } from './pendingEdits';
import { Switch } from './primitives';

/** `undefined` = 기계 값을 모른다(배정 없음·오프라인·옛 오퍼레이터). 그때는 막지 않는다 — 러너가 다시 닫는다. */
export function AgentChromeSection({ agent, machine, disabled, onUpdated }: {
  agent: AgentView;
  machine: ChromeHostState | undefined;
  disabled?: boolean;
  onUpdated: (next: AgentView) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 경고 확인은 **그 에이전트에서 직접 켠 동작**에만 붙는다(security F3). 상세 영역은 에이전트를 바꿔도 다시 그려지지 않으므로
  // (부르는 쪽이 `key` 를 주지만) 여기서도 id 가 바뀌면 확인·오류를 비운다 — A 에서 띄운 경고로 B 를 켜는 길을 닫는다.
  const [shownFor, setShownFor] = useState(agent.id);
  if (shownFor !== agent.id) { setShownFor(agent.id); setConfirming(false); setError(null); }
  const cancelRef = useRef<HTMLButtonElement>(null);
  // 위험 버튼에 기본 포커스를 두지 않는다(designer n3) — 경고가 뜨면 [취소]로 보낸다.
  useEffect(() => { if (confirming) cancelRef.current?.focus(); }, [confirming]);

  const on = agent.chromeEnabled === true;
  const readOnly = agent.mentionPermission === 'readonly';
  const blocked = readOnly ? 'readonly' : machine === 'remote' || machine === 'no_extension' ? machine : null;

  const save = async (chromeEnabled: boolean) => {
    setBusy(true); setError(null);
    try {
      onUpdated(await getController().updateAgent(agent.id, { chromeEnabled }));
      setConfirming(false);
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'human_session_required'
        ? t('agents.chrome.errHumanOnly')
        : t('agents.chrome.errFailed', { reason: errorText(e, t) }));
    } finally { setBusy(false); }
  };

  const blockedText = {
    readonly: t('agents.chrome.blockedReadonly'),
    remote: t('agents.chrome.blockedRemote'),
    no_extension: t('agents.chrome.blockedNoExtension'),
  } as const;
  // 켜져 있는데 막힌 까닭이 있으면 「켜짐이지만 안 붙는다」를 말한다 — 스위치만 보면 붙는 줄 안다.
  const status = on
    ? (blocked ? t('agents.chrome.onButBlocked', { reason: blockedText[blocked] }) : t('agents.chrome.on'))
    : confirming ? t('agents.chrome.pending')
    : (blocked ? t('agents.chrome.offBlocked', { reason: blockedText[blocked] }) : machine === undefined ? t('agents.chrome.offUnknown') : t('agents.chrome.off'));

  return (
    <div className="rounded-row border border-border p-3" data-testid="agent-chrome">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-meta font-medium text-fg-muted">{t('agents.chrome.heading')}<ImmediateBadge label={t('agents.detail.immediate')} /></div>
          <p className={`mt-1 text-meta ${on && blocked ? 'text-warning' : 'text-fg-subtle'}`} data-testid="agent-chrome-status">{status}</p>
        </div>
        <Switch
          ariaLabel={t('agents.chrome.heading')}
          testId="agent-chrome-toggle"
          checked={on || confirming}
          // 켜진 것은 언제나 끌 수 있다. 꺼진 것은 막힌 까닭이 있으면 켜지 못한다.
          disabled={busy || disabled || (!on && blocked !== null)}
          onChange={(next) => {
            if (!next) { if (confirming) setConfirming(false); else void save(false); return; }
            setConfirming(true);
          }}
          className="mt-0.5"
        />
      </div>
      {confirming && (
        <div className="mt-3 rounded-row border border-warning-border bg-warning-surface p-3 text-meta" role="alert" data-testid="agent-chrome-warning"
          onKeyDown={(e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); setConfirming(false); } }}>
          <p className="font-medium text-fg">{t('agents.chrome.warnTitle', { handle: agent.handle })}</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-fg-muted">
            <li>{t('agents.chrome.warnSites')}</li>
            <li>{t('agents.chrome.warnInjection')}</li>
            <li>{t('agents.chrome.warnUnattended')}</li>
          </ul>
          <div className="mt-3 flex gap-2">
            <button type="button" className="rounded-row bg-danger px-3 py-1 font-medium text-fg-on-strong hover:bg-danger-hover disabled:opacity-50"
              data-testid="agent-chrome-confirm" disabled={busy} onClick={() => void save(true)}>
              {t('agents.chrome.confirm')}
            </button>
            <button type="button" ref={cancelRef} className="rounded-row border border-border px-3 py-1 text-fg-muted hover:bg-surface-sunken disabled:opacity-50"
              data-testid="agent-chrome-cancel" disabled={busy} onClick={() => setConfirming(false)}>
              {t('agents.chrome.cancel')}
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-meta text-danger" role="alert">{error}</p>}
    </div>
  );
}
