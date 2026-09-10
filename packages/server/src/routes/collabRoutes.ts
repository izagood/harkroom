import type { FastifyInstance } from 'fastify';
import type { CollabProposalsView } from '@murmur/shared';
import type { Pool } from 'pg';
import { httpAvcsClient } from '../avcs/client.js';
import { ProposalReader } from '../avcs/proposalReader.js';
import type { Proposal } from '../avcs/proposals.js';
import { listBoundRepos } from '../services/channels.js';

/**
 * 협업 탭이 읽는 표면(`docs/hub-seat.md` 0단계, `docs/desktop-collab.html`).
 *
 * ## 왜 채널 메시지가 아니라 이 라우트인가
 *
 * #534 가 avcs 객체를 채팅으로 투영하던 것을 걷어냈다. 제안은 **머무는 것**이고 채널 메시지는
 * 흘러가는 것이라, 같은 사실을 두 모양으로 두면 채팅 쪽 사본이 원본을 가린다. 그래서 협업 탭은
 * avcs 를 직접 읽고, 그 읽기가 여기다.
 *
 * ## 왜 `/leases` 와 같은 게이트(requireAccount)인가
 *
 * 제안 목록은 저장소에 바인딩된 채널에서 나오는데, 그 바인딩은 채널 가시성과 무관하게 걸린다
 * (`listBoundRepos` 가 private 채널도 센다 — `channels.ts` 의 같은 판단). 지금은 avcs 서버
 * 자체가 워크스페이스 하나를 상대로 열려 있으므로 계정이면 읽는다. **저장소별 권한이 생기면
 * 그때 좁혀야 하는 자리가 여기라는 뜻**이기도 하다.
 */
export async function registerCollabRoutes(
  app: FastifyInstance,
  pool: Pool,
  projection?: { currentUrl(): string | null },
  reader: ProposalReader = new ProposalReader(httpAvcsClient),
): Promise<void> {
  app.get('/collab/proposals', { preHandler: app.requireAccount }, async (): Promise<CollabProposalsView> => {
    const baseUrl = projection?.currentUrl() ?? null;
    // 보고 있는 서버가 없으면 제안도 없다 — `/leases` 와 같은 논리다. 빈 목록과 "설정되지
    // 않았다" 를 화면이 구분할 수 있게 `baseUrl` 을 함께 준다.
    if (baseUrl === null) return { baseUrl: null, repos: [] };

    const bound = await listBoundRepos(pool);
    // 한 저장소가 채널 둘에 걸릴 수 있다. 그때 avcs 를 두 번 읽을 이유는 없다 — 저장소로
    // 접고, 어느 채널들이 그것을 보고 있는지는 목록으로 돌려준다(화면이 "여기서 이어 말하기"
    // 를 걸 자리다).
    const byRepo = new Map<string, string[]>();
    for (const { repo, channelId } of bound) {
      const seen = byRepo.get(repo);
      if (seen) seen.push(channelId);
      else byRepo.set(repo, [channelId]);
    }

    const keyIds = new Set<string>();
    const repos = [];
    for (const [repo, channelIds] of [...byRepo].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        const view = await reader.read(baseUrl, repo);
        for (const p of view.proposals) collectKeyIds(p, keyIds);
        repos.push({ repo, channelIds, error: null, ...view });
      } catch (err) {
        // 저장소 하나가 죽었다고 목록 전체를 비우지 않는다. 어느 저장소가 안 보이는지
        // 화면이 말할 수 있어야 하고, 나머지는 그대로 서야 한다.
        app.log.warn({ repo, err }, 'collab: repo read failed');
        repos.push({ repo, channelIds, error: 'unreachable', proposals: [], reducedAt: null });
      }
    }

    return { baseUrl, repos, actors: await resolveActors(pool, keyIds) };
  });
}

function collectKeyIds(p: Proposal, into: Set<string>): void {
  if (p.ownerKeyId) into.add(p.ownerKeyId);
  for (const op of p.ops) {
    if (op.actorKeyId) into.add(op.actorKeyId);
    for (const e of op.evidence) if (e.actorKeyId) into.add(e.actorKeyId);
  }
  for (const d of p.decisions) if (d.decidedByKeyId) into.add(d.decidedByKeyId);
}

/**
 * avcs 의 actor 키를 murmur 계정으로 되짚는다 — 줄이 말하는 넷 중 **"누가"** 이고, 얼굴
 * (`Identity.tsx`)이 여기서 온다.
 *
 * **모르는 키는 목록에 없다.** 그것이 곧 "외부 작업자" 이고, 화면은 그때 키를 그대로 보여
 * 주면 된다 — 없는 계정을 지어내면 아바타 캐시가 남의 얼굴을 붙인다.
 */
async function resolveActors(pool: Pool, keyIds: Set<string>): Promise<Record<string, string>> {
  if (!keyIds.size) return {};
  const res = await pool.query(
    `select key_id as "keyId", account_id as "accountId" from account_key where key_id = any($1::text[])`,
    [[...keyIds]],
  );
  const out: Record<string, string> = {};
  for (const row of res.rows as { keyId: string; accountId: string }[]) out[row.keyId] = row.accountId;
  return out;
}
