/**
 * 「머지·API·명령 권한」 절의 **명령 허용** 줄(명령 허용 줄 시안 v1, 소유자 결정 2026-10-30 1~8). 카드 승인은 7일 고정이고
 * 30일·무기한은 설정 화면에서만 준다(스레드 f61af808 D3) — 이 화면이 그 자리다. 서버 `PUT /accounts/:id/grants`
 * (`tool.allow`, scope `tool:<channelId>:<규칙>`)를 그대로 부른다.
 *
 * 판정은 서버가 한다. 화면이 `validateToolRule` 을 먼저 부르는 것은 틀린 줄을 줄 번호로 보여 주고 위험 규칙의 「없음」 칸을
 * 끄기 위해서다 — 같은 shared 함수라 어긋나지 않고, 서버도 같은 판정으로 다시 막는다(`tool_rule_needs_expiry` 등).
 */
import { useEffect, useState } from 'react';
import {
  TOOL_RULE_CAPPED_EXPIRY_MS, orderToolRuleWarnings, parseToolScope, toolRuleExpiryCapped, toolScope, validateToolRule,
  type AgentView, type ChannelRow, type GrantRow, type ToolRuleRefusal, type ToolRuleWarning,
} from '@harkroom/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { useLocale, useT } from '../../i18n/useT';
import type { MessageKey } from '../../i18n/en';
import { ConfirmDialog } from '../ConfirmDialog';

export const TOOL_CAP = 'tool.allow' as const;
const DAY = 86_400_000;
/** 카드 승인의 기한(서버 `PERMISSION_GRANT_TTL_MS`). 줄에는 출처가 없어 준 때와 만료의 차이로 「카드로」를 가늠한다. */
const CARD_TTL_MS = 7 * DAY;
type ToolExpiry = '7d' | '30d' | 'none';

const REFUSAL_KEY: Record<ToolRuleRefusal, MessageKey> = {
  empty: 'toolAllow.refuse.empty',
  too_long: 'toolAllow.refuse.too_long',
  unsupported_tool: 'toolAllow.refuse.unsupported_tool',
  wildcard: 'toolAllow.refuse.wildcard',
  too_broad: 'toolAllow.refuse.too_broad',
  shell_syntax: 'toolAllow.refuse.shell_syntax',
  dangerous_flag: 'toolAllow.refuse.dangerous_flag',
  interpreter: 'toolAllow.refuse.interpreter',
  operator_wrapper: 'toolAllow.refuse.operator_wrapper',
  merge_bypass: 'toolAllow.refuse.merge_bypass',
  bad_chars: 'toolAllow.refuse.bad_chars',
  gh_api_write: 'toolAllow.refuse.gh_api_write',
  env_prefix: 'toolAllow.refuse.env_prefix',
  path_head: 'toolAllow.refuse.path_head',
  relative_path: 'toolAllow.refuse.relative_path',
  glued_flag: 'toolAllow.refuse.glued_flag',
  needs_kubeconfig: 'toolAllow.refuse.needs_kubeconfig',
  unsupported_head: 'toolAllow.refuse.unsupported_head',
  unsupported_subcommand: 'toolAllow.refuse.unsupported_subcommand',
  unsupported_flag: 'toolAllow.refuse.unsupported_flag',
  chart_not_pinned: 'toolAllow.refuse.chart_not_pinned',
};
// 카드(`MandateLineBody`)와 같은 낱말을 쓴다.
const WARN_KEY: Record<ToolRuleWarning, MessageKey> = {
  runs_arbitrary: 'mandateCard.warn.runs_arbitrary.head',
  executes_in_workload: 'mandateCard.warn.executes_in_workload.head',
  mutates_remote: 'mandateCard.warn.mutates_remote.head',
  unclassified: 'mandateCard.warn.unclassified.head',
  reads_file: 'mandateCard.warn.reads_file.head',
  short_prefix: 'mandateCard.warn.short_prefix.head',
  uses_github_account: 'mandateCard.warn.uses_github_account.head',
};
const DANGER: readonly ToolRuleWarning[] = ['runs_arbitrary', 'executes_in_workload', 'mutates_remote'];

/** 카드 승인으로 생긴 줄로 보이나 — 준 때부터 만료까지가 카드 기한(7일)과 몇 분 안으로 같다. 설정에서 고른 7일도 같게 보인다. */
export function looksCardGranted(g: GrantRow): boolean {
  if (g.expiresAt === null) return false;
  return Math.abs(Date.parse(g.expiresAt) - Date.parse(g.grantedAt) - CARD_TTL_MS) < 10 * 60_000;
}

export function WarnBadges({ warnings }: { warnings: readonly ToolRuleWarning[] }) {
  const t = useT();
  return <>{orderToolRuleWarnings(warnings).map((w) => (
    <span key={w} className={`ml-2 inline-block rounded-row border px-1 ${DANGER.includes(w) ? 'border-danger-border bg-danger-surface text-danger' : 'border-warning-border bg-warning-surface text-warning'}`}
      data-testid={`tool-allow-warn-${w}`}>{t(WARN_KEY[w])}</span>
  ))}</>;
}

/** 이 에이전트가 들어 있는 채널 — 채널 칩 후보(시안 ②). 멤버 목록을 못 읽은 채널은 뺀다. */
function useAgentChannels(agentId: string, enabled: boolean): ChannelRow[] | null {
  const channels = useActiveStore((s) => s.channels);
  const [ids, setIds] = useState<string[] | null>(null);
  const key = channels.filter((c) => c.kind === 'standard' && !c.archivedAt).map((c) => c.id).join(',');
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const list = key ? key.split(',') : [];
    void Promise.all(list.map(async (id) => {
      const cached = useActiveStore.getState().channelMembers[id];
      const members = cached ?? await getController().loadChannelMembers(id).catch(() => null);
      return members?.some((m) => m.accountId === agentId) ? id : null;
    })).then((found) => { if (alive) setIds(found.filter((x): x is string => x !== null)); });
    return () => { alive = false; };
  }, [agentId, key, enabled]);
  return ids === null ? null : channels.filter((c) => ids.includes(c.id));
}

export function ToolAllowList({ rows, canGrant, canRevoke, off, onRenew, onRevoke }: {
  rows: readonly GrantRow[];
  canGrant: boolean;
  canRevoke: boolean;
  off: boolean;
  onRenew: (g: GrantRow) => void;
  onRevoke: (g: GrantRow) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const accounts = useActiveStore((s) => s.accounts);
  const channels = useActiveStore((s) => s.channels);
  const now = Date.now();
  return (
    // 규칙이 길어 좁은 폭에서는 표가 무너진다(시안 ④) — 줄마다 카드로 쌓고, 넓으면 같은 칸이 줄 맞춰 선다.
    <ul className="mt-1 divide-y divide-border rounded-row border border-border text-meta" data-testid="agent-tool-allows">
      {rows.map((g) => {
        const parsed = parseToolScope(g.scope);
        const rule = parsed?.rule ?? g.scope;
        const verdict = validateToolRule(rule);
        const warnings = verdict.ok ? verdict.warnings : [];
        const ch = channels.find((c) => c.id === parsed?.channelId);
        const expired = g.expiresAt !== null && Date.parse(g.expiresAt) <= now;
        const uncapped = g.expiresAt === null && toolRuleExpiryCapped(warnings);
        const left = g.expiresAt !== null && !expired ? Date.parse(g.expiresAt) - now : null;
        // 7일 안으로 남은 줄 — 남은 날을 주황으로 보이고 [30일로]를 단다.
        const soon = left !== null && left < 7 * DAY;
        // [30일로] — 카드로 받은 줄, 상한 밖에 남은 위험 줄(지적 2), 끝났거나 7일 안으로 남은 줄. 설정에서 30일로 준 줄에는 하루 뒤에도 달지 않는다.
        const short = looksCardGranted(g) || uncapped || expired || soon;
        return (
          <li key={g.scope} className={`grid grid-cols-1 gap-x-3 gap-y-1 px-2 py-1 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start ${expired ? 'text-fg-subtle' : 'text-fg'}`}
            data-testid={`agent-tool-allow-${rule}`} data-expired={expired || undefined}>
            <span className="min-w-0 break-all">
              <span className="font-mono">{rule}</span>
              <WarnBadges warnings={warnings} />
            </span>
            <span className="text-fg-subtle">{ch?.name ? `#${ch.name}` : t('toolAllow.unknownChannel')}</span>
            <span className="text-fg-subtle">
              {t('agents.grants.by', { handle: accounts[g.grantedBy]?.handle ?? g.grantedBy, when: new Date(g.grantedAt).toLocaleDateString(locale) })}
            </span>
            <span className="text-fg-subtle">
              {/* 만료 없음은 주황 — 잊힌 채 남는 줄이 눈에 걸리게(「마지막 사용」이 없는 동안 남은 표지다). */}
              {g.expiresAt === null
                ? <span className="text-warning" data-testid={`tool-allow-no-expiry-${rule}`}>{t('agents.grants.noExpiry')}</span>
                : expired ? t('agents.grants.expired') : (
                  <span className={soon ? 'text-warning' : undefined} data-testid={soon ? `tool-allow-soon-${rule}` : undefined}>
                    {t('agents.grants.expiresOn', { when: new Date(g.expiresAt).toLocaleDateString(locale) })}
                    {soon && ` · ${t('toolAllow.daysLeft', { days: String(Math.max(1, Math.ceil(left! / DAY))) })}`}
                  </span>
                )}
              {/* 상한(#1687) 전에 만료 없이 들어간 위험 규칙 줄 — 서버는 이제 이런 줄을 새로 받지 않는다(security 지적 2). */}
              {uncapped && (
                <span className="mt-0.5 block text-warning" data-testid={`tool-allow-uncapped-${rule}`}>{t('toolAllow.uncappedWarning')}</span>
              )}
              {looksCardGranted(g) && (
                <span className="ml-2 rounded-row bg-accent-surface px-1 text-accent-text" data-testid={`tool-allow-card-${rule}`}>{t('toolAllow.viaCard')}</span>
              )}
            </span>
            <span className="flex gap-2 sm:justify-end">
              {canGrant && short && (
                <button className="rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:bg-surface-sunken disabled:opacity-50" disabled={off}
                  aria-label={t('toolAllow.renewAria', { rule })} onClick={() => onRenew(g)}>
                  {expired ? t('toolAllow.renewAgain30d') : t('toolAllow.renew30d')}
                </button>
              )}
              {canRevoke && (
                <button className="rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:text-danger disabled:opacity-50" disabled={off}
                  aria-label={t('toolAllow.revokeAria', { rule })} onClick={() => onRevoke(g)}>
                  {t('agents.grants.revoke')}
                </button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** 30일 다시 주기 — 같은 scope 에 PUT 하면 서버가 만료·준 사람을 새 값으로 바꾼다. */
export function renewToolAllow(agentId: string, g: GrantRow): Promise<unknown> {
  return getController().putGrant(agentId, { capability: TOOL_CAP, scope: g.scope, expiresAt: new Date(Date.now() + 30 * DAY).toISOString() });
}

export function ToolAllowForm({ agent, off, run, onCancel }: {
  agent: AgentView;
  off: boolean;
  /** 부모의 바쁨·오류·다시 읽기 틀(`AgentGrantsSection.run`). 던지면 부모가 사람 말로 옮긴다. */
  run: (fn: () => Promise<void>) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<ToolExpiry>('30d');
  const [confirmNone, setConfirmNone] = useState(false);
  const channels = useAgentChannels(agent.id, true);

  const lines = text.split('\n').map((raw, i) => ({ n: i + 1, raw: raw.trim() })).filter((l) => l.raw !== '');
  const checked = lines.map((l) => ({ ...l, v: validateToolRule(l.raw) }));
  const bad = checked.filter((l) => !l.v.ok);
  const good = [...new Map(checked.flatMap((l) => (l.v.ok ? [[l.v.rule, l.v.warnings] as const] : []))).entries()];
  const capped = good.some(([, w]) => toolRuleExpiryCapped(w));
  const effective: ToolExpiry = capped && expiry === 'none' ? '30d' : expiry;
  const ready = good.length > 0 && bad.length === 0 && picked.length > 0;

  const submit = () => run(async () => {
    // 상한 규칙의 30일은 서버 상한(`TOOL_RULE_CAPPED_EXPIRY_MS`, 1분 여유) 안에 든다.
    const at = effective === 'none' ? null : new Date(Date.now() + Math.min(effective === '7d' ? 7 * DAY : 30 * DAY, TOOL_RULE_CAPPED_EXPIRY_MS)).toISOString();
    for (const ch of picked) for (const [rule] of good) {
      await getController().putGrant(agent.id, { capability: TOOL_CAP, scope: toolScope(ch, rule), expiresAt: at });
    }
    onCancel();
  });

  const expiryOpts: { value: ToolExpiry; label: string; disabled?: boolean }[] = [
    { value: '7d', label: t('agents.grants.expiry7d') },
    { value: '30d', label: t('toolAllow.expiry30dDefault') },
    { value: 'none', label: t('agents.grants.expiryNone'), disabled: capped },
  ];

  return (
    <div className="mt-2 rounded-row border border-border bg-surface-sunken p-2" data-testid="agent-tool-allow-add">
      <label className="flex flex-col gap-1 text-meta text-fg">
        {t('toolAllow.rules')}
        <textarea aria-label={t('toolAllow.rules')} disabled={off} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={t('toolAllow.rulesPlaceholder')}
          className="min-h-[3rem] rounded-row border border-border bg-surface px-2 py-1 font-mono text-meta text-fg" />
      </label>
      <p className="mt-1 text-meta text-fg-subtle">{t('toolAllow.rulesHint')}</p>
      {bad.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-meta text-danger" role="alert" data-testid="tool-allow-bad">
          {bad.map((l) => <li key={l.n}>{t('toolAllow.badLine', { n: String(l.n), reason: l.v.ok ? '' : t(REFUSAL_KEY[l.v.code]) })}</li>)}
        </ul>
      )}
      {good.some(([, w]) => w.length > 0) && (
        <ul className="mt-1 space-y-0.5 text-meta">
          {good.filter(([, w]) => w.length > 0).map(([rule, w]) => (
            <li key={rule}><span className="font-mono">{rule}</span><WarnBadges warnings={w} /></li>
          ))}
        </ul>
      )}

      <div className="mt-2 text-meta text-fg">{t('toolAllow.channels')}</div>
      {channels === null
        ? <p className="mt-1 text-meta text-fg-subtle">{t('agents.grants.loading')}</p>
        : channels.length === 0
          ? <p className="mt-1 text-meta text-fg-subtle" data-testid="tool-allow-no-channels">{t('toolAllow.noChannels')}</p>
          : (
            <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label={t('toolAllow.channels')}>
              {channels.map((c) => {
                const on = picked.includes(c.id);
                return (
                  <button key={c.id} type="button" aria-pressed={on} disabled={off} data-testid={`tool-allow-chip-${c.id}`}
                    className={`rounded-row border px-2 py-0.5 text-meta disabled:opacity-50 ${on ? 'border-accent bg-accent-surface text-accent-text' : 'border-border bg-surface text-fg hover:bg-surface-sunken'}`}
                    onClick={() => setPicked(on ? picked.filter((x) => x !== c.id) : [...picked, c.id])}>
                    #{c.name ?? c.id.slice(0, 8)}
                  </button>
                );
              })}
            </div>
          )}

      <fieldset className="mt-2 flex flex-wrap items-center gap-3 text-meta text-fg">
        <legend className="sr-only">{t('agents.grants.expiry')}</legend>
        <span>{t('agents.grants.expiry')}</span>
        {expiryOpts.map((o) => (
          <label key={o.value} className={`flex items-center gap-1 ${o.disabled ? 'text-fg-subtle' : ''}`}>
            <input type="radio" name={`tool-expiry-${agent.id}`} value={o.value} checked={effective === o.value} disabled={off || o.disabled}
              onChange={() => setExpiry(o.value)} />
            {o.label}
          </label>
        ))}
      </fieldset>
      {capped && <p className="mt-1 text-meta text-fg-subtle" data-testid="tool-allow-capped">{t('toolAllow.cappedNote')}</p>}
      {effective === 'none' && <p className="mt-1 text-meta text-warning" data-testid="tool-allow-none-warning">{t('toolAllow.noneWarning')}</p>}

      <div className="mt-2 flex gap-2">
        <button className="rounded-row border border-border bg-accent px-2 py-1 text-meta font-medium text-accent-fg disabled:opacity-50"
          disabled={off || !ready} onClick={() => (effective === 'none' ? setConfirmNone(true) : void submit())}>
          {effective === 'none' ? t('toolAllow.confirmNoneButton') : t('agents.grants.confirmAdd')}
        </button>
        <button className="rounded-row border border-border px-2 py-1 text-meta text-fg hover:bg-surface disabled:opacity-50" disabled={off} onClick={onCancel}>
          {t('agents.grants.cancel')}
        </button>
      </div>
      {confirmNone && (
        <ConfirmDialog
          title={t('toolAllow.confirmNoneTitle', { handle: agent.handle })}
          detail={t('toolAllow.confirmNoneDetail', { n: String(good.length * picked.length) })}
          confirmLabel={t('toolAllow.confirmNoneButton')}
          cancelLabel={t('agents.grants.cancel')}
          detailKind="note"
          danger
          busy={off}
          onCancel={() => setConfirmNone(false)}
          onConfirm={() => { setConfirmNone(false); void submit(); }}
        />
      )}
    </div>
  );
}
