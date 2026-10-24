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

/** API 키 연결을 쓸 수 있는 하네스(러너 `PROVIDER_LANE_ENV_KEYS` 와 같은 목록). */
export const LANE_HARNESSES: readonly string[] = ['claude-code', 'opencode', 'codex', 'omp'];
/**
 * 계정 풀이 없어 API 키로만 도는 하네스(omp — 사람 홈에 로그인·제공자가 없으면 돌 모델이 없다, designer #1540 c1·4).
 * [계정 풀]을 누르면 빈자리 대신 그렇다고 한 줄을 쓰고, 저장된 연결이 없으면 처음부터 [API 키]로 연다.
 */
export const LANE_ONLY_HARNESSES: readonly string[] = ['omp'];

type LaneBaseUrlLabel = 'agents.lane.baseUrl' | 'agents.lane.baseUrl.responses' | 'agents.lane.baseUrl.omp';
/**
 * 주소 칸 이름 — 하네스가 gateway 를 부르는 꼴을 적는다(designer n4 A). claude-code·opencode 는 Anthropic 꼴(`/v1/messages`),
 * codex 는 OpenAI Responses 꼴(`/v1/responses`), omp 는 OpenAI chat-completions 꼴이다. 표에 없으면 Anthropic 이름이다.
 */
const LANE_BASE_URL_LABEL: Readonly<Record<string, LaneBaseUrlLabel>> = {
  codex: 'agents.lane.baseUrl.responses',
  omp: 'agents.lane.baseUrl.omp',
};
export function laneBaseUrlLabel(harness: string): LaneBaseUrlLabel {
  return LANE_BASE_URL_LABEL[harness] ?? 'agents.lane.baseUrl';
}
/**
 * 예전에 opencode lane 모델 칸에 붙이던 머리(러너 `PROVIDER_LANE_OPENCODE_PROVIDER`). 이제 모델 칸에는 gateway 가 받는 이름을 그대로 적고,
 * 머리는 러너가 opencode 를 띄울 때만 안에서 붙인다(2026-10-24). 남은 옛 값은 이 함수로 원문으로 되돌린다.
 */
export const LEGACY_LANE_MODEL_PREFIX = 'harkroom-lane/';

/** 모델 칸 값에 옛 머리가 붙어 있으면 뗀 원문 — 붙어 있지 않으면 null(고칠 것 없음). */
export function laneModelRaw(model: string | null): string | null {
  const m = model?.trim() ?? '';
  return m.startsWith(LEGACY_LANE_MODEL_PREFIX) && m.length > LEGACY_LANE_MODEL_PREFIX.length ? m.slice(LEGACY_LANE_MODEL_PREFIX.length) : null;
}

type UrlProblem = 'badScheme' | 'badParts' | null;
/** 화면이 말할 까닭을 가른다. 판정 자체는 shared `normalizeProviderBaseUrl` 이 한다(오퍼레이터가 다시 잰다). */
/** 하네스 이름 목록 — ko 는 「·」, 그 밖은 그 언어의 「A, B and C」(designer #1541 n3). */
export function harnessList(names: readonly string[], locale: string): string {
  if (locale === 'ko') return names.join('·');
  return new Intl.ListFormat(locale, { type: 'conjunction' }).format(names);
}

export function urlProblem(raw: string): UrlProblem {
  if (!raw.trim() || normalizeProviderBaseUrl(raw)) return null;
  try {
    const u = new URL(raw.trim());
    if (u.username || u.password || u.search || u.hash) return 'badParts';
  } catch { /* 아래 */ }
  return 'badScheme';
}

export function ModelConnectionField({ harness, lane, pool, stdioServers, label, onOpenSecrets, onOpenPermissions, onSaved }: {
  harness: string;
  lane: ProviderLaneState;
  /** [계정 풀]일 때 그릴 지금 화면. */
  pool: ReactNode;
  /** 이 에이전트에 붙은 외부 stdio MCP 서버 이름(harkroom 제외). */
  stdioServers: readonly string[];
  /** 칸 이름 글자 모양(부모 폼과 맞춘다). */
  label: string;
  onOpenSecrets?: () => void;
  /** 권한 탭으로(붙은 stdio MCP 를 떼러, designer n3). */
  onOpenPermissions?: () => void;
  /** 저장이 끝났다(켬/끔) — opencode 모델 칸 채우기 등은 부모가 한다. */
  onSaved?: (next: ProviderLaneConfig | null) => Promise<void> | void;
}) {
  const t = useT();
  const locale = useLocale();
  const saved = lane.lane;
  const laneOnly = LANE_ONLY_HARNESSES.includes(harness);
  const [mode, setMode] = useState<'pool' | 'apiKey'>(saved || laneOnly ? 'apiKey' : 'pool');
  const [url, setUrl] = useState(saved?.baseUrl ?? '');
  const [secretName, setSecretName] = useState(saved?.secretName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMode(saved || laneOnly ? 'apiKey' : 'pool');
    setUrl(saved?.baseUrl ?? '');
    setSecretName(saved?.secretName ?? '');
  }, [saved?.baseUrl, saved?.secretName, laneOnly]);

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
      {!harnessOk && <span className="mt-1 block text-meta text-fg-subtle">{t('agents.lane.harnessOnly', { harnesses: harnessList(LANE_HARNESSES, locale) })}</span>}

      {mode === 'pool' && saved === null && !laneOnly && <div className="mt-2">{pool}</div>}
      {mode === 'pool' && saved === null && laneOnly && (
        <span className="mt-2 block text-meta text-fg-subtle" data-testid="lane-only-pool">{t('agents.lane.noPoolHarness', { harness })}</span>
      )}

      {mode === 'pool' && saved !== null && (
        <div className="mt-2 rounded-row bg-warning-surface px-3 py-2 text-meta text-warning" data-testid="lane-off-confirm">
          {laneOnly ? t('agents.lane.offConfirmNoPool', { harness }) : t('agents.lane.offConfirm')}
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
            {t(laneBaseUrlLabel(harness))}
            <input
              className={`mt-1 block w-full rounded-row border bg-surface px-2 py-1.5 font-mono text-meta text-fg ${problem ? 'border-danger' : 'border-border'}`}
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
          {/* 붙은 stdio 서버가 없으면 회색 한 줄로 줄인다(designer n11) — 붙어 있을 때만 노란 상자와 [권한 탭에서 떼기](n3). */}
          {stdioServers.length === 0 ? (
            <span className="text-meta text-fg-subtle" data-testid="lane-stdio-hint">{t('agents.lane.stdioHint')}</span>
          ) : (
            <div className="rounded-row bg-warning-surface px-3 py-2 text-meta text-warning" data-testid="lane-stdio-warn">
              {t('agents.lane.stdioWarn')}
              <span className="mt-1 block font-medium" data-testid="lane-stdio-attached">
                {t('agents.lane.stdioAttached', { n: stdioServers.length, names: stdioServers.join(', ') })}
                {onOpenPermissions && <>{' '}<button type="button" className="underline" onClick={onOpenPermissions}>{t('agents.lane.detachInPermissions')}</button></>}
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="rounded-row bg-accent px-3 py-1 text-fg-on-strong disabled:opacity-50"
              disabled={!canSave || !dirty} data-testid="lane-save"
              onClick={() => save({ baseUrl: normalized!, secretName })}>{t('agents.lane.save')}</button>
            <button type="button" className="rounded-row border border-border px-3 py-1 text-fg disabled:opacity-50" disabled={!dirty || busy}
              onClick={() => { setUrl(saved?.baseUrl ?? ''); setSecretName(saved?.secretName ?? ''); if (!saved && !laneOnly) setMode('pool'); }}>
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

/** 대기가 이만큼 길면 「러너가 다시 뜨지 않았다」로 바꾼다(designer n14). 보통은 10초 안에 다시 뜬다(실물 3차). */
export const LANE_PENDING_STUCK_MS = 3 * 60_000;

/**
 * 실행 탭 곁 칸 — 이 API 키 연결의 상태. 맨 위 한 칸을 「적용 대기」와 「마지막 턴」이 **번갈아** 쓴다 — 대기 상자가 사라질 때
 * 아래 줄들이 위로 튀지 않게(designer n18).
 */
export function ModelConnectionStatus({ lane, harness, now, onRestart }: {
  lane: ProviderLaneState;
  /** 이 에이전트의 하네스 — 판 문장에 그 하네스의 판만 싣는다(designer n1). 모르면 모두. */
  harness?: string;
  /** 시험이 시각을 고정한다. */
  now?: number;
  /** [재시작] — 대기가 오래가면 보인다(n14). 없으면 버튼을 그리지 않는다. */
  onRestart?: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const status = lane.status;
  const time = useMemo(() => (status ? new Date(status.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false }) : ''), [status, locale]);
  // 3분이 되는 순간 스스로 다시 그린다(designer n20) — 다른 렌더(5초 다시 읽기)에 기대면 그 읽기가 같은 참조를 돌려줄 때
  // [재시작]이 끝내 안 뜬다. 시험은 `now` 로 시각을 고정한다.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!lane.pending || lane.pendingSince === null || now !== undefined) return;
    const left = lane.pendingSince + LANE_PENDING_STUCK_MS - Date.now();
    if (left <= 0) return;
    const id = window.setTimeout(() => setTick((n) => n + 1), left + 50);
    return () => window.clearTimeout(id);
  }, [lane.pending, lane.pendingSince, now]);
  if (!lane.lane && !lane.pending) return null;
  const nowMs = now ?? Date.now();
  const stuck = lane.pending && lane.pendingSince !== null && nowMs - lane.pendingSince >= LANE_PENDING_STUCK_MS;
  const slot = (() => {
    if (lane.pending) {
      return (
        <div className="rounded-row bg-warning-surface px-3 py-2 text-meta text-warning" data-testid="lane-pending" role="status">
          {/* 끈 직후면 방향(계정 풀로 돌아감)을 밝힌다(designer s2). 오래가면 다시 뜨지 않은 것이다(n14). */}
          {stuck ? t('agents.lane.pendingStuck') : t(lane.lane ? 'agents.lane.pending' : 'agents.lane.pendingOff')}
          {stuck && onRestart && <>{' '}<button type="button" className="underline" data-testid="lane-pending-restart" onClick={onRestart}>{t('agents.lane.restart')}</button></>}
        </div>
      );
    }
    // 다른 상태와 같은 면(designer s2) — 면 없이 여백만 주면 이 줄만 들여 쓴 것처럼 보인다. n16 회색 줄과 같은 「아직 되지 않음」 무게다.
    if (status === null) return <div className="rounded-row bg-surface-sunken px-3 py-2 text-meta text-fg-subtle" data-testid="lane-status-none">{t('agents.lane.lastNone')}</div>;
    if (!status.ok) {
      return (
        <div className="rounded-row bg-danger-surface px-3 py-2 text-meta text-danger" data-testid="lane-status-fail">
          ✕ {t('agents.lane.lastFail', { time, reason: laneCodeText(t, status.code, harness) })} <span className="font-mono">{status.code ?? 'unknown'}</span>
        </div>
      );
    }
    // 키는 받았는데 그 턴은 API 오류로 끝났다 — 초록으로 그리면 「됐다」로 읽힌다(n16).
    if (status.apiFailed) {
      return <div className="rounded-row bg-surface-sunken px-3 py-2 text-meta text-fg-muted" data-testid="lane-status-apifail">{t('agents.lane.lastApiFailed', { time })}</div>;
    }
    return <div className="rounded-row bg-success-surface px-3 py-2 text-meta text-success" data-testid="lane-status-ok">✓ {t('agents.lane.lastOk', { time })}</div>;
  })();
  return (
    <section className="flex flex-col gap-2" data-testid="lane-status">
      {/* 끈 직후에는 「이 API 키 연결」이 아니다 — 「적용 상태」(n15). */}
      <h3 className="text-meta font-medium text-fg-muted">{t(lane.lane ? 'agents.lane.statusTitle' : 'agents.lane.statusTitleOff')}</h3>
      {slot}
      {lane.lane && <>
        <span className="text-meta text-fg-subtle">{t('agents.lane.statusScope')}</span>
        <span className="text-meta text-fg-subtle">{t('agents.lane.noPool')}</span>
        <span className="text-meta text-fg-subtle">{t('agents.lane.terminalBlocked')}</span>
        <span className="text-meta text-fg-subtle">{t('agents.lane.moveNote')}</span>
      </>}
    </section>
  );
}

/** 만들기 화면의 API 키 연결 초안(n19). 비밀은 **내 비밀** 하나를 id 로 고른다 — 만들기가 그 비밀을 새 에이전트에게 준다. */
export interface CreateLaneDraft { mode: 'pool' | 'apiKey'; url: string; secretId: string }
/** 만들기 고르개의 한 줄 — 이름만 싣는다(값·reveal 은 부르지 않는다, security G2). */
export interface CreateLaneSecret { id: string; name: string; expired: boolean }

/** 만들 때 쓸 lane — 다 차지 않았으면 null. 만료된 비밀·목록에 없는 비밀은 받지 않는다. */
export function createLaneSelection(d: CreateLaneDraft, secrets: readonly CreateLaneSecret[] | null | undefined): { config: ProviderLaneConfig; secretId: string } | null {
  if (d.mode !== 'apiKey') return null;
  const baseUrl = normalizeProviderBaseUrl(d.url);
  const secret = (secrets ?? []).find((s) => s.id === d.secretId && !s.expired);
  if (!baseUrl || !secret || !PROVIDER_SECRET_NAME.test(secret.name)) return null;
  return { config: { baseUrl, secretName: secret.name }, secretId: secret.id };
}

/**
 * **만들기 화면의 「모델 연결」**(n19, designer 시안 v1). 상세의 [계정 풀 | API 키]와 같은 고르기를 만들 때 한다.
 * [Save]·[Revert]·재시작 안내는 없다 — 하단 [Create agent] 하나가 만들기·설정 저장·띄우기·비밀 주기를 한다(`controller.createAgent`).
 * - 「이 맥에서 돌리기」가 꺼져 있으면 [API key] 를 잠그고 까닭을 쓴다(설정이 이 맥에 산다).
 * - API 키를 못 쓰는 하네스는 숨기지 않고 상세처럼 잠근다(jaebin 승인 카드 57c97470).
 * - 비밀은 내 것만 보인다. 고르면 무엇을 누구에게 주는지 상자로 미리 보인다(security G4).
 */
export function CreateModelConnectionField({ harness, runHere, value, onChange, pool, label, secrets, handle }: {
  harness: string;
  /** 「이 맥에서 돌리기」가 켜져 있고 이 맥 오퍼레이터가 있다. */
  runHere: boolean;
  value: CreateLaneDraft;
  onChange(next: CreateLaneDraft): void;
  pool: ReactNode;
  label: string;
  /** 내 비밀(null = 못 읽음, undefined = 읽는 중). */
  secrets: readonly CreateLaneSecret[] | null | undefined;
  /** 이름 칸의 handle(비었으면 「새 에이전트」). */
  handle: string;
}) {
  const t = useT();
  const locale = useLocale();
  const harnessOk = LANE_HARNESSES.includes(harness);
  const laneOnly = LANE_ONLY_HARNESSES.includes(harness);
  const blocked = !harnessOk ? t('agents.lane.harnessOnly', { harnesses: harnessList(LANE_HARNESSES, locale) })
    : !runHere ? t('agents.lane.createNeedsRunHere') : null;
  const mode: 'pool' | 'apiKey' = blocked ? (laneOnly ? 'apiKey' : 'pool') : laneOnly ? 'apiKey' : value.mode;
  const problem = urlProblem(value.url);
  const picked = (secrets ?? []).find((s) => s.id === value.secretId && !s.expired) ?? null;
  const who = handle.trim() ? `@${handle.trim()}` : t('agents.lane.createGiveNewAgent');
  return (
    <div className={label} data-testid="create-model-connection">
      <span>{t('agents.run.modelConnection')} <span className="text-fg-subtle">· {t('agents.run.modelConnection.thisDevice')}</span></span>
      <div className="mt-1">
        <Segmented
          label={t('agents.run.modelConnection')}
          value={mode}
          onChange={(v) => { if (!blocked && !laneOnly) onChange({ ...value, mode: v as 'pool' | 'apiKey' }); }}
          options={[
            { value: 'pool', label: t('agents.run.loginPool') },
            { value: 'apiKey', label: t('agents.run.loginApiKey') },
          ]}
        />
      </div>
      {blocked && <span className="mt-1 block text-meta text-fg-subtle" data-testid="create-lane-blocked">{blocked}</span>}
      {mode === 'pool' && <div className="mt-2">{pool}</div>}
      {mode === 'apiKey' && laneOnly && !blocked && <span className="mt-1 block text-meta text-fg-subtle">{t('agents.lane.noPoolHarness', { harness })}</span>}
      {mode === 'apiKey' && !blocked && (
        <div className="mt-2 flex flex-col gap-3" data-testid="create-lane-form">
          <label className="block">
            {t(laneBaseUrlLabel(harness))}
            <input
              className={`mt-1 block w-full rounded-row border bg-surface px-2 py-1.5 font-mono text-meta text-fg ${problem ? 'border-danger' : 'border-border'}`}
              value={value.url} onChange={(e) => onChange({ ...value, url: e.target.value })} placeholder="https://gateway.example" spellCheck={false}
              aria-invalid={problem !== null} data-testid="create-lane-url"
            />
            <span className={`mt-1 block text-meta ${problem ? 'text-danger' : 'text-fg-subtle'}`}>
              {problem === 'badParts' ? t('agents.lane.badParts') : problem === 'badScheme' ? t('agents.lane.badScheme') : t('agents.lane.baseUrlHint')}
            </span>
          </label>
          <div>
            {t('agents.lane.secret')}
            {secrets === undefined ? (
              <span className="mt-1 block text-meta text-fg-subtle">{t('agents.lane.secretsLoading')}</span>
            ) : secrets === null ? (
              <span className="mt-1 block text-meta text-danger" role="alert">{t('agents.lane.createSecretsFailed')}</span>
            ) : secrets.length === 0 ? (
              <div className="mt-1 rounded-row border border-dashed border-border px-2 py-2 text-meta text-fg-subtle" data-testid="create-lane-no-secrets">
                {/* 링크가 아니라 글이다 — 설정의 다른 칸으로 가면 이 만들기 초안이 사라진다(designer 미확인 a, 확인함). */}
                {t('agents.lane.createNoSecrets')} · {t('agents.lane.createNoSecretsWhere')}
              </div>
            ) : (
              <div className="mt-1 overflow-hidden rounded-row border border-border" role="radiogroup" aria-label={t('agents.lane.secret')} data-testid="create-lane-secrets">
                {secrets.map((s) => (
                  <label key={s.id} className={`flex items-center justify-between gap-2 border-b border-border px-2 py-1.5 text-meta last:border-b-0 ${s.expired ? 'opacity-55' : ''}`}>
                    <span className="flex min-w-0 items-center gap-2">
                      <input type="radio" name="create-lane-secret" disabled={s.expired} checked={value.secretId === s.id}
                        onChange={() => onChange({ ...value, secretId: s.id })} />
                      <span className="truncate font-mono">{s.name}</span>
                    </span>
                    <span className={`shrink-0 rounded-full px-2 text-meta ${s.expired ? 'bg-surface-sunken text-fg-muted' : 'bg-info-surface text-info'}`}>
                      {s.expired ? t('agents.lane.createSecretExpired') : t('agents.lane.createSecretYours')}
                    </span>
                  </label>
                ))}
                <div className="px-2 py-1.5 text-meta text-fg-subtle">
                  {t('agents.lane.createOnlyYours')}
                </div>
              </div>
            )}
            {picked && (
              <div className="mt-2 flex gap-2 rounded-row bg-info-surface px-3 py-2 text-meta text-info" data-testid="create-lane-give">
                <span aria-hidden>🔑</span><span>{t('agents.lane.createGive', { who })}</span>
              </div>
            )}
            <span className="mt-1 block text-meta text-fg-subtle">{t('agents.lane.secretNote')}</span>
          </div>
          <div className="flex gap-2 rounded-row bg-surface-sunken px-3 py-2 text-meta text-fg-subtle">
            <span aria-hidden>🔒</span><span>{t('agents.lane.desktopOnly')}</span>
          </div>
          <span className="text-meta text-fg-subtle">{t('agents.lane.stdioHint')}</span>
        </div>
      )}
    </div>
  );
}

/** 만들기의 API 키 연결 단계 중 하나라도 실패했나(n19). */
export function createLaneFailed(r: { saved: string; given: string; running: string }): boolean {
  return r.saved === 'fail' || r.given === 'fail' || r.running === 'fail';
}

/**
 * 만들기 중간 실패 상자(n19 ③). 만든 에이전트는 남는다. 어느 단계까지 됐는지 ✓/✕/– 로 보이고, 비밀을 이미 줬으면 거두는 곳을 쓴다(security G5).
 */
export function CreateLaneFailure({ handle, secretName, result, onOpenSecrets, onOpenAgent }: {
  handle: string;
  secretName: string;
  result: { saved: 'ok' | 'fail' | 'skip'; given: 'ok' | 'fail' | 'skip'; running: 'ok' | 'fail' | 'skip'; reason: string | null };
  onOpenSecrets?: () => void;
  onOpenAgent?: () => void;
}) {
  const t = useT();
  const mark = (s: 'ok' | 'fail' | 'skip') => (s === 'ok' ? '✓' : s === 'fail' ? '✕' : '–');
  const tone = (s: 'ok' | 'fail' | 'skip') => (s === 'ok' ? 'text-success' : s === 'fail' ? 'text-danger' : 'text-fg-subtle');
  const reason = result.reason ?? '';
  const rows: { state: 'ok' | 'fail' | 'skip'; text: string }[] = [
    { state: 'ok', text: t('agents.lane.createStepCreated') },
    { state: result.saved, text: result.saved === 'fail' ? t('agents.lane.createStepSavedFail', { reason }) : result.saved === 'ok' ? t('agents.lane.createStepSaved') : t('agents.lane.createStepSavedSkip') },
    { state: result.given, text: result.given === 'fail' ? t('agents.lane.createStepGivenFail', { secret: secretName, reason }) : result.given === 'ok' ? t('agents.lane.createStepGiven', { secret: secretName }) : t('agents.lane.createStepGivenSkip') },
    { state: result.running, text: result.running === 'fail' ? t('agents.lane.createStepRunningFail', { reason }) : result.running === 'ok' ? t('agents.lane.createStepRunning') : t('agents.lane.createStepRunningSkip') },
  ];
  return (
    <div role="alert" className="mb-2 rounded-row bg-danger-surface px-3 py-2 text-meta text-danger" data-testid="create-lane-failure">
      <b>{result.running === 'ok' ? t('agents.lane.createFailHeadRunning', { handle }) : t('agents.lane.createFailHead', { handle })}</b>
      <ol className="my-1.5">
        {rows.map((r, i) => (
          <li key={i} className="flex gap-1.5"><span className={tone(r.state)} aria-hidden>{mark(r.state)}</span><span>{r.text}</span></li>
        ))}
      </ol>
      {result.given === 'ok' && <span className="block" data-testid="create-lane-given-note">{t('agents.lane.createGivenNote')}</span>}
      <div className="mt-1 flex flex-wrap gap-3">
        {onOpenSecrets && <button type="button" className="underline" onClick={onOpenSecrets}>{t('agents.lane.createOpenSecrets')}</button>}
        {onOpenAgent && <button type="button" className="underline" onClick={onOpenAgent}>{t('agents.lane.createOpenAgent', { handle })}</button>}
      </div>
    </div>
  );
}
