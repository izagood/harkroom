import { useEffect, useState } from 'react';
import { listClaudeAccounts, openClaudeAccountTerminal } from '../lib/claudeAccounts';
import { resolveGateTerminalTarget, type GateTerminalTarget } from '../lib/gateTerminal';
import { hasOperatorLocalSurface, listLocalAgents } from '../lib/operatorLocal';
import { getController } from '../state/controller';
import { operatorNameOf } from '../lib/operatorName';
import { useT } from '../i18n/useT';

/**
 * 계정 관문 실패 카드의 [터미널 열기](2026-10-02, 관문 대응 PR-4).
 *
 * 무엇을 열지는 `resolveGateTerminalTarget` 이 정한다 — meta 의 풀·계정 순번을 **이 기기의 풀 순서**에서
 * 찾고, 데몬에는 (풀, 계정) 이름만 넘긴다. 이 기기에서 열 수 없으면(웹·모바일·다른 오퍼레이터)
 * 버튼 대신 "<오퍼레이터>에서 열기" 문구를 보인다. 창은 사람이 누를 때만 연다.
 */
export function GateTerminalButton({ poolRank, accountRank, agentId }: { poolRank?: number | undefined; accountRank: number; agentId: string }) {
  const t = useT();
  const target = useGateTerminalTarget(poolRank, accountRank, agentId);
  const [state, setState] = useState<'idle' | 'opening' | 'opened' | 'failed'>('idle');

  if (target.kind === 'unknown') return null;
  if (target.kind === 'elsewhere') {
    return (
      <span data-testid="gate-terminal-elsewhere" className="text-meta text-fg-muted">
        {target.operatorName
          ? t('gate.terminal.elsewhere', { operator: target.operatorName })
          : t('gate.terminal.elsewhereUnknown')}
      </span>
    );
  }
  if (target.kind === 'missing') {
    return (
      <button
        type="button"
        data-testid="gate-terminal-open"
        disabled
        title={t('gate.terminal.missing')}
        className="rounded-row border border-border bg-surface-raised px-2 py-0.5 text-meta font-medium text-fg-muted opacity-60"
      >
        {t('gate.terminal.open')}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        data-testid="gate-terminal-open"
        disabled={state === 'opening'}
        className="rounded-row bg-accent px-2 py-0.5 text-meta font-medium text-fg-on-strong hover:bg-accent-hover"
        onClick={() => {
          setState('opening');
          openClaudeAccountTerminal(target.pool, target.account)
            .then(() => setState('opened'), () => setState('failed'));
        }}
      >
        {t('gate.terminal.open')}
      </button>
      {/* 이 기기에서 순번으로 찾은 계정 이름(designer #1978-1) — 누르기 전에 어느 계정이 열리는지 보인다.
          이름은 이 기기 데스크톱에서만 그린다(서버로 가지 않는다 — 원칙 A). */}
      <span data-testid="gate-terminal-account" className="font-mono text-meta text-fg-muted">{target.account}</span>
      {state === 'opened' && <span className="text-meta text-fg-muted">{t('gate.terminal.opened')}</span>}
      {state === 'failed' && <span className="text-meta text-state-stuck">{t('gate.terminal.failed')}</span>}
    </span>
  );
}

/** 사실을 모아 `resolveGateTerminalTarget` 에 넘긴다. 읽기 실패는 "모른다"가 아니라 그 사실의 부재로 둔다. */
export function useGateTerminalTarget(poolRank: number | undefined, accountRank: number, agentId: string): GateTerminalTarget {
  const [target, setTarget] = useState<GateTerminalTarget>({ kind: 'unknown' });
  useEffect(() => {
    let alive = true;
    void (async () => {
      const hasLocalSurface = hasOperatorLocalSurface();
      let baseUrl: string | null = null;
      try { baseUrl = getController().api?.baseUrl ?? null; } catch { /* 컨트롤러가 아직 없다 */ }
      let agentIsLocal: boolean | null = hasLocalSurface ? null : false;
      let localPool: string | null = null;
      if (hasLocalSurface && baseUrl) {
        const local = await listLocalAgents().catch(() => null);
        const mine = local?.communities.find((c) => c.baseUrl === baseUrl) ?? null;
        if (local) {
          agentIsLocal = Boolean(mine?.agents[agentId]);
          localPool = mine?.agents[agentId]?.claudePool ?? null;
        }
      }
      const snapshot = agentIsLocal ? await listClaudeAccounts().catch(() => null) : null;
      // 문구용 오퍼레이터 이름 — 여기서만 쓰고, 못 읽으면 이름 없는 문구로 물러선다.
      let operatorName: string | null = null;
      if (agentIsLocal === false) {
        const agents = await Promise.resolve().then(() => getController().listAgents()).catch(() => null);
        const opId = agents?.find((a) => a.id === agentId)?.assignment?.operatorId ?? null;
        if (opId) operatorName = operatorNameOf((await Promise.resolve().then(() => getController().operators()).catch(() => null))?.find((o) => o.id === opId)) ?? null;
      }
      if (!alive) return;
      setTarget(resolveGateTerminalTarget({ poolRank, accountRank, agentId, hasLocalSurface, agentIsLocal, operatorName, snapshot, localPool }));
    })();
    return () => { alive = false; };
  }, [poolRank, accountRank, agentId]);
  return target;
}
