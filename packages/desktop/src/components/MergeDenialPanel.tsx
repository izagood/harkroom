import { useState } from 'react';
import type { MessageRow } from '@harkroom/shared';
import { getController } from '../state/controller';
import { useActiveStore } from '../state/communities';
import { useLocale, useT } from '../i18n/useT';
import type { SectionId } from './settings/sections';

/**
 * 머지 거절 카드의 권한 칸(머지 UX P5, 스레드 febe9ff8). 에이전트가 `message.ask` 에 `mergeDenialId` 를 실어 세운 카드에
 * 서버가 거절 기록으로 채운 `meta.mergeDenial` 을 그린다 — 「다시 머지」·「나중에」는 그 아래 `AskCard` 의 선택지다.
 *
 * [7일 주기]는 ask 선택지가 아니다(security C5). **에이전트 소유자인 사람**에게만 서고, 그 사람 세션의 REST
 * (`POST /agents/:id/merge-denials/:denialId/grant`)로 간다. scope·기한은 서버가 거절 기록과 상수로 정한다.
 * 배포 저장소(`deployRepo`)면 버튼 대신 「설정에서」만 둔다(C6).
 *
 * 저장소 이름은 **전부 크게** 보인다(security L1) — 그 값은 에이전트가 래퍼에 보낸 이름이라, 주는 사람이 정확히 무엇에
 * 주는지 읽을 수 있어야 한다. PR 링크는 서버 기록의 저장소·번호로만 만든다(`https://github.com/{repo}/pull/{n}`) — 에이전트
 * 본문의 링크는 쓰지 않고, 모양이 어긋나면 링크를 걸지 않는다.
 */
export interface MergeDenialMeta {
  denialId: string; agentId: string; ownerAccountId: string | null; repo: string; number: number;
  deployRepo: boolean; count: number; lastAt: string;
  granted?: { by: string; at: string; expiresAt: string };
}

const REPO_RE = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9._-]{1,100}$/i;

export function readMergeDenial(meta: Record<string, unknown>): MergeDenialMeta | null {
  const d = meta.mergeDenial as Partial<MergeDenialMeta> | undefined;
  if (!d || typeof d.denialId !== 'string' || typeof d.agentId !== 'string' || typeof d.repo !== 'string') return null;
  const g = d.granted;
  return {
    denialId: d.denialId, agentId: d.agentId, ownerAccountId: typeof d.ownerAccountId === 'string' ? d.ownerAccountId : null,
    repo: d.repo, number: typeof d.number === 'number' ? d.number : 0, deployRepo: d.deployRepo === true,
    count: typeof d.count === 'number' ? d.count : 1, lastAt: typeof d.lastAt === 'string' ? d.lastAt : '',
    ...(g && typeof g.expiresAt === 'string' && typeof g.by === 'string' ? { granted: { by: g.by, at: String(g.at ?? ''), expiresAt: g.expiresAt } } : {}),
  };
}

/** 서버 기록으로만 만든 PR 주소. 저장소·번호 모양이 어긋나면 null — 링크를 걸지 않는다. */
export function prUrlOf(d: Pick<MergeDenialMeta, 'repo' | 'number'>): string | null {
  if (!REPO_RE.test(d.repo) || !Number.isInteger(d.number) || d.number <= 0) return null;
  return `https://github.com/${d.repo}/pull/${d.number}`;
}

export function MergeDenialPanel({ message, onOpenSettings }: { message: MessageRow; onOpenSettings?: (section?: SectionId, targetId?: string) => void }) {
  const t = useT();
  const locale = useLocale();
  const d = readMergeDenial(message.meta);
  const me = useActiveStore((s) => s.me);
  const accounts = useActiveStore((s) => s.accounts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [givenUntil, setGivenUntil] = useState<string | null>(null);
  if (!d) return null;

  const handle = accounts[d.agentId]?.handle ?? d.agentId.slice(0, 8);
  const owner = d.ownerAccountId ? accounts[d.ownerAccountId]?.handle ?? '?' : '?';
  const isOwner = !!me && d.ownerAccountId === me.id && me.kind === 'human';
  const url = prUrlOf(d);
  const fmt = (iso: string) => new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  const until = givenUntil ?? d.granted?.expiresAt ?? null;

  const give = async () => {
    setBusy(true); setError(null);
    try {
      const r = await getController().grantFromMergeDenial(d.agentId, d.denialId);
      setGivenUntil(r.expiresAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1 rounded border border-border border-l-4 border-warning-border bg-surface-raised p-2 text-meta" data-testid="merge-denial-card">
      <div className="font-medium text-fg">🔒 {t('mergeDenial.title', { handle })}</div>
      <div className="mt-1 break-all font-mono text-body font-semibold text-fg" data-testid="merge-denial-repo">{d.repo}</div>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-fg-subtle">{t('mergeDenial.pr')}</dt>
        <dd>
          {url
            ? <a href={url} target="_blank" rel="noreferrer noopener" className="text-accent underline" data-testid="merge-denial-pr">#{d.number}</a>
            : <span>#{d.number}</span>}
        </dd>
        <dt className="text-fg-subtle">{t('blocked.today')}</dt>
        <dd>{t('blocked.count', { n: String(d.count), when: d.lastAt ? new Date(d.lastAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '' })}</dd>
      </dl>
      {until && <p className="mt-1 text-fg" data-testid="merge-denial-granted">{t('mergeDenial.granted', { date: fmt(until) })}</p>}
      {!until && isOwner && !d.deployRepo && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy} data-testid="merge-denial-give"
            className="rounded bg-accent px-2 py-1 font-medium text-fg-on-strong disabled:opacity-60" onClick={() => void give()}>
            {t('mergeDenial.give')}
          </button>
          <span className="text-fg-subtle">{t('mergeDenial.giveNote')}</span>
        </div>
      )}
      {!until && isOwner && d.deployRepo && (
        <div className="mt-2" data-testid="merge-denial-deploy">
          <p className="text-fg-muted">{t('mergeDenial.deployRepo')}</p>
          {onOpenSettings && (
            <button type="button" className="mt-1 rounded border border-border px-2 py-1 text-fg-muted" onClick={() => onOpenSettings('agents', d.agentId)}>
              {t('blocked.openSettings')}
            </button>
          )}
        </div>
      )}
      {!until && !isOwner && <p className="mt-1 text-fg-subtle" data-testid="merge-denial-owner-only">{t('blocked.ownerOnly', { owner })}</p>}
      {error && <p className="mt-1 text-danger" role="alert" data-testid="merge-denial-error">{t('mergeDenial.failed', { reason: error })}</p>}
    </div>
  );
}
