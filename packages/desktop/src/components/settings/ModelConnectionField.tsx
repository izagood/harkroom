/**
 * 실행 탭 「모델 연결」 — [계정 풀 | API 키] 둘 중 하나(designer v3 안 A, 결정 카드 13fd6e7a).
 *
 * - [계정 풀]이면 지금 화면(풀 순서 칸)을 그대로 그린다(`pool`). [API 키]면 그 자리에 주소·비밀 고르기가 선다 — 둘이 한
 *   자리에서 서로를 밀어내므로 「풀 계정과 섞지 않는다」(security ⓒ)가 화면 구조에서 드러난다.
 * - **전환은 저장 전까지 아무것도 쓰지 않는다.** 저장은 [저장]·[지우고 저장] 클릭에서만 `operatorAgentProviderLaneSet` 을
 *   부른다(security n2). 끄기는 `lane: null` 로 그 칸을 지운다.
 * - 키 값은 이 화면에 없다. 허락된 비밀의 **이름**만 고른다(`useProviderLane`).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { normalizeProviderBaseUrl, PROVIDER_SECRET_NAME, type ProviderLaneConfig } from '@harkroom/shared/providerLane';
import { useLocale, useT } from '../../i18n/useT';
import type { ProviderLaneState } from '../../lib/useProviderLane';
import { laneCodeText } from '../../lib/laneCodes';
import { Segmented } from './primitives';

/** API 키 연결을 쓸 수 있는 하네스(러너 `PROVIDER_LANE_ENV_KEYS` 와 같은 둘). */
export const LANE_HARNESSES: readonly string[] = ['claude-code', 'opencode'];
/** opencode 가 lane 모델을 부르는 이름(러너 `PROVIDER_LANE_OPENCODE_PROVIDER`). */
export const OPENCODE_LANE_PREFIX = 'harkroom-lane/';

/** opencode 모델 칸에 넣을 값 — 이미 lane 모양이거나 모델이 비었으면 null(고칠 것 없음). */
export function opencodeLaneModel(model: string | null): string | null {
  const m = model?.trim() ?? '';
  if (!m || m.startsWith(OPENCODE_LANE_PREFIX)) return null;
  return `${OPENCODE_LANE_PREFIX}${m.includes('/') ? m.slice(m.lastIndexOf('/') + 1) : m}`;
}

type UrlProblem = 'badScheme' | 'badParts' | null;
/** 화면이 말할 까닭을 가른다. 판정 자체는 shared `normalizeProviderBaseUrl` 이 한다(오퍼레이터가 다시 잰다). */
export function urlProblem(raw: string): UrlProblem {
  if (!raw.trim() || normalizeProviderBaseUrl(raw)) return null;
  try {
    const u = new URL(raw.trim());
    if (u.username || u.password || u.search || u.hash) return 'badParts';
  } catch { /* 아래 */ }
  return 'badScheme';
}

export function ModelConnectionField({ harness, lane, pool, stdioServers, label, onOpenSecrets, onSaved }: {
  harness: string;
  lane: ProviderLaneState;
  /** [계정 풀]일 때 그릴 지금 화면. */
  pool: ReactNode;
  /** 이 에이전트에 붙은 외부 stdio MCP 서버 이름(harkroom 제외). */
  stdioServers: readonly string[];
  /** 칸 이름 글자 모양(부모 폼과 맞춘다). */
  label: string;
  onOpenSecrets?: () => void;
  /** 저장이 끝났다(켬/끔) — opencode 모델 칸 채우기 등은 부모가 한다. */
  onSaved?: (next: ProviderLaneConfig | null) => Promise<void> | void;
}) {
  const t = useT();
  const saved = lane.lane;
  const [mode, setMode] = useState<'pool' | 'apiKey'>(saved ? 'apiKey' : 'pool');
  const [url, setUrl] = useState(saved?.baseUrl ?? '');
  const [secretName, setSecretName] = useState(saved?.secretName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMode(saved ? 'apiKey' : 'pool');
    setUrl(saved?.baseUrl ?? '');
    setSecretName(saved?.secretName ?? '');
  }, [saved?.baseUrl, saved?.secretName]);

  const harnessOk = LANE_HARNESSES.includes(harness);
  const problem = urlProblem(url);
  const normalized = normalizeProviderBaseUrl(url);
  const options = lane.secrets ?? [];
  const picked = options.find((o) => o.name === secretName) ?? null;
  const canSave = mode === 'apiKey' && !!normalized && PROVIDER_SECRET_NAME.test(secretName) && !!picked?.granted && !busy;
  const dirty = mode === 'apiKey'
    ? (normalized ?? url) !== (saved?.baseUrl ?? '') || secretName !== (saved?.secretName ?? '')
    : saved !== null;

  const save = (next: ProviderLaneConfig | null) => {
    setBusy(true);
    setError(null);
    void lane.save(next)
      .then(() => onSaved?.(next))
      .then(() => lane.reload())
      .catch((e: unknown) => setError(t('agents.lane.saveFailed', { reason: e instanceof Error ? e.message : String(e) })))
      .finally(() => setBusy(false));
  };

  return (
    <div className={label} data-testid="model-connection">
      <span>{t('agents.run.modelConnection')} <span className="text-fg-subtle">· {t('agents.run.modelConnection.thisDevice')}</span></span>
      <div className="mt-1">
        <Segmented
          label={t('agents.run.modelConnection')}
          value={mode}
          onChange={(v) => { if (v === 'pool' || harnessOk) setMode(v as 'pool' | 'apiKey'); }}
          options={[
            { value: 'pool', label: t('agents.run.loginPool') },
            { value: 'apiKey', label: t('agents.run.loginApiKey') },
          ]}
        />
      </div>
      {!harnessOk && <span className="mt-1 block text-meta text-fg-subtle">{t('agents.lane.harnessOnly')}</span>}

      {mode === 'pool' && saved === null && <div className="mt-2">{pool}</div>}

      {mode === 'pool' && saved !== null && (
        <div className="mt-2 rounded-row bg-warning-surface px-3 py-2 text-meta text-warning" data-testid="lane-off-confirm">
          {t('agents.lane.offConfirm')}
          <div className="mt-2 flex gap-2">
            <button type="button" className="rounded-row bg-accent px-3 py-1 text-fg-on-strong disabled:opacity-50" disabled={busy}
              onClick={() => save(null)}>{t('agents.lane.offSave')}</button>
            <button type="button" className="rounded-row border border-border px-3 py-1 text-fg" disabled={busy}
              onClick={() => setMode('apiKey')}>{t('agents.lane.cancel')}</button>
          </div>
        </div>
      )}

      {mode === 'apiKey' && harnessOk && (
        <div className="mt-2 flex flex-col gap-3" data-testid="lane-form">
          <label className="block">
            {t('agents.lane.baseUrl')}
            <input
              className={`mt-1 block w-full rounded-row border bg-surface px-2 py-1.5 font-mono text-body text-fg ${problem ? 'border-danger' : 'border-border'}`}
              value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://gateway.example" spellCheck={false}
              aria-invalid={problem !== null} data-testid="lane-url"
            />
            <span className={`mt-1 block text-meta ${problem ? 'text-danger' : 'text-fg-subtle'}`}>
              {problem === 'badParts' ? t('agents.lane.badParts') : problem === 'badScheme' ? t('agents.lane.badScheme') : t('agents.lane.baseUrlHint')}
            </span>
          </label>

          <div>
            {t('agents.lane.secret')}
            <SecretPicker lane={lane} value={secretName} onChange={setSecretName} onOpenSecrets={onOpenSecrets} />
            <span className="mt-1 block text-meta text-fg-subtle">{t('agents.lane.secretNote')}</span>
          </div>

          <div className="flex gap-2 rounded-row bg-surface-sunken px-3 py-2 text-meta text-fg-subtle" data-testid="lane-desktop-only">
            <span aria-hidden>🔒</span><span>{t('agents.lane.desktopOnly')}</span>
          </div>
          <div className="rounded-row bg-warning-surface px-3 py-2 text-meta text-warning">
            {t('agents.lane.stdioWarn')}
            {stdioServers.length > 0 && (
              <span className="mt-1 block font-medium" data-testid="lane-stdio-attached">
                {t('agents.lane.stdioAttached', { n: stdioServers.length, names: stdioServers.join(', ') })}
              </span>
            )}
          </div>
          {harness === 'opencode' && <span className="text-meta text-fg-subtle">{t('agents.lane.opencodeModel')}</span>}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="rounded-row bg-accent px-3 py-1 text-fg-on-strong disabled:opacity-50"
              disabled={!canSave || !dirty} data-testid="lane-save"
              onClick={() => save({ baseUrl: normalized!, secretName })}>{t('agents.lane.save')}</button>
            <button type="button" className="rounded-row border border-border px-3 py-1 text-fg disabled:opacity-50" disabled={!dirty || busy}
              onClick={() => { setUrl(saved?.baseUrl ?? ''); setSecretName(saved?.secretName ?? ''); if (!saved) setMode('pool'); }}>
              {t('agents.lane.revert')}
            </button>
            {/* 켜기는 러너가 다시 떠야 들고, 이미 켠 연결의 주소·비밀 바꾸기는 다음 턴에 든다(C1). */}
            <span className="text-meta text-fg-subtle">{t(saved === null ? 'agents.lane.restartNote' : 'agents.lane.applyNote')}</span>
          </div>
        </div>
      )}
      {error && <span className="mt-1 block text-meta text-danger">{error}</span>}
    </div>
  );
}

function SecretPicker({ lane, value, onChange, onOpenSecrets }: {
  lane: ProviderLaneState; value: string; onChange(next: string): void; onOpenSecrets?: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const link = onOpenSecrets
    ? <button type="button" className="underline" onClick={onOpenSecrets}>{t('agents.lane.grantLink')}</button>
    : <span>{t('agents.lane.grantLink')}</span>;
  if (lane.secretsError) {
    return (
      <div className="mt-1 text-meta text-danger" data-testid="lane-secrets-error">
        {t('agents.lane.secretsFailed', { reason: lane.secretsError })}{' '}
        <button type="button" className="underline" onClick={lane.reload}>{t('agents.lane.retry')}</button>
      </div>
    );
  }
  if (lane.secrets === null) return <div className="mt-1 text-meta text-fg-subtle">…</div>;
  if (lane.secrets.length === 0) {
    return (
      <div className="mt-1 rounded-row border border-border px-2 py-1.5 text-meta text-fg-subtle" data-testid="lane-no-secrets">
        {t('agents.lane.noSecrets')} · {link}
      </div>
    );
  }
  return (
    <div role="radiogroup" aria-label={t('agents.lane.secret')} className="mt-1 overflow-hidden rounded-row border border-border" data-testid="lane-secrets">
      {lane.secrets.map((s) => {
        const on = s.name === value;
        const chip = s.unreadable ? t('agents.lane.unreadable')
          : s.suspended ? t('agents.lane.suspended')
          : s.channelLimited ? t('agents.lane.channelLimited')
          : s.expiresAt ? t('agents.lane.grantedUntil', { date: new Date(s.expiresAt).toLocaleDateString(locale) })
          : t('agents.lane.granted');
        return (
          <button key={s.id} type="button" role="radio" aria-checked={on} disabled={!s.granted}
            className={`flex w-full items-center justify-between gap-2 border-b border-border px-2 py-1.5 text-left last:border-b-0 disabled:opacity-60 ${on ? 'ring-1 ring-inset ring-border-strong' : 'hover:bg-surface-hover'}`}
            onClick={() => onChange(s.name)}>
            {/* 고른 줄은 점과 테두리로 가린다 — 옅은 면만 쓰면 hover 와 같아져 저장된 키가 어느 것인지 안 보인다. */}
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden data-testid="lane-secret-dot" className={on ? 'text-accent' : 'text-fg-subtle'}>{on ? '●' : '○'}</span>
              <span className="min-w-0 truncate font-mono text-body">{s.name}</span>
            </span>
            <span className={`shrink-0 rounded-full px-2 text-meta ${s.granted && !s.channelLimited ? 'bg-success-surface text-success' : 'bg-warning-surface text-warning'}`}>{chip}</span>
          </button>
        );
      })}
      <div className="px-2 py-1.5 text-meta text-fg-subtle">{t('agents.lane.grantedOnly')} · {link}</div>
    </div>
  );
}

/** 실행 탭 곁 칸 — 이 API 키 연결의 마지막 키 받기 결과(오퍼레이터가 본 것, `laneStatus`). */
export function ModelConnectionStatus({ lane }: { lane: ProviderLaneState }) {
  const t = useT();
  const locale = useLocale();
  const status = lane.status;
  const time = useMemo(() => (status ? new Date(status.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false }) : ''), [status, locale]);
  if (!lane.lane && !lane.pending) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="lane-status">
      <h3 className="text-meta font-medium text-fg-muted">{t('agents.lane.statusTitle')}</h3>
      {/* C1: 설정과 러너 모드가 다르다 — 러너가 도는 턴을 끝내고 다시 뜨기 전이다. 그동안 오퍼레이터가 새 턴을 막는다. */}
      {lane.pending && (
        <div className="rounded-row bg-warning-surface px-3 py-2 text-meta text-warning" data-testid="lane-pending" role="status">
          {t('agents.lane.pending')}
        </div>
      )}
      {status === null && <div className="text-meta text-fg-subtle">{t('agents.lane.lastNone')}</div>}
      {status?.ok && <div className="rounded-row bg-success-surface px-3 py-2 text-meta text-success">✓ {t('agents.lane.lastOk', { time })}</div>}
      {status && !status.ok && (
        <div className="rounded-row bg-danger-surface px-3 py-2 text-meta text-danger" data-testid="lane-status-fail">
          ✕ {t('agents.lane.lastFail', { time, reason: laneCodeText(t, status.code) })} <span className="font-mono">{status.code ?? 'unknown'}</span>
        </div>
      )}
      <span className="text-meta text-fg-subtle">{t('agents.lane.statusScope')}</span>
      <span className="text-meta text-fg-subtle">{t('agents.lane.noPool')}</span>
      <span className="text-meta text-fg-subtle">{t('agents.lane.terminalBlocked')}</span>
      <span className="text-meta text-fg-subtle">{t('agents.lane.moveNote')}</span>
    </section>
  );
}
