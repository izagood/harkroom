import type { FastifyInstance } from 'fastify';
import type { CollabProposalsView } from '@harkroom/shared';
import type { Pool } from 'pg';
import { httpAvcsClient } from '../avcs/client.js';
import { ProposalReader } from '../avcs/proposalReader.js';
import type { Proposal } from '../avcs/proposals.js';
import { listBoundRepos } from '../services/channels.js';
import { ensureRepo, resolveRepoBaseUrl, type RepoRow } from '../services/repos.js';

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
  /**
   * murmur 가 직접 띄우는 avcs 서버(`avcs/host.ts`). **없어도 된다** — `hosted` 저장소가 없는
   * 워크스페이스에서는 이 표면이 그것을 부를 일도 없다.
   */
  avcsHost?: { ensure(): Promise<string | null>; startError(): unknown },
): Promise<void> {
  app.get('/collab/proposals', { preHandler: app.requireAccount }, async (): Promise<CollabProposalsView> => {
    // 전역 주소는 이제 **기본값**이다. 저장소가 자기 주소를 들고 있으면 그것이 이긴다
    // (051 · `resolveRepoBaseUrl`). 판정은 그 함수 하나에만 둔다.
    const fallback = projection?.currentUrl() ?? null;

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

    // 바인딩된 저장소의 행을 보장한다 — 채널에 `repo` 를 걸자마자 협업 탭에 보여야지,
    // 설정 화면에서 행을 만들 때까지 안 보이면 사람은 바인딩이 안 걸린 줄 안다.
    const rows = new Map<string, RepoRow>();
    for (const slug of byRepo.keys()) rows.set(slug, await ensureRepo(pool, slug));

    // 전역도 없고, 자기 주소를 든 저장소도, 호스팅하는 저장소도 없으면 **아직 설정되지 않은
    // 것**이다. 이때만 빈 목록으로 답한다 — "제안이 없다" 와 "볼 서버가 없다" 는 다른 말이다.
    const anySource = fallback !== null
      || [...rows.values()].some((r) => r.baseUrl !== null || r.mode === 'hosted');
    if (!anySource) return { baseUrl: null, repos: [] };

    // 호스트는 **필요할 때만** 띄운다(`avcs/host.ts`): hosted 저장소가 없는 워크스페이스에서
    // 포트와 데이터 루트를 잡으면, 쓰지도 않는 상태가 백업 대상에 올라간다.
    let hostedUrl: string | null = null;
    if ([...rows.values()].some((r) => r.mode === 'hosted')) {
      hostedUrl = (await avcsHost?.ensure()) ?? null;
      if (hostedUrl === null) {
        // 못 띄운 사유는 로그에 남긴다 — 화면에는 `no-server` 만 서고, 그 줄만으로는
        // "설정을 안 했다" 와 "띄우다 실패했다" 를 구분할 수 없다.
        app.log.warn({ err: avcsHost?.startError() }, 'collab: hosted avcs server unavailable');
      }
    }

    const keyIds = new Set<string>();
    const repos = [];
    for (const [repo, channelIds] of [...byRepo].sort(([a], [b]) => a.localeCompare(b))) {
      const row = rows.get(repo) ?? null;
      const mode = row?.mode ?? 'linked';
      const url = resolveRepoBaseUrl(row, fallback, hostedUrl);
      const head = { repo, channelIds, mode, baseUrl: url };
      if (url === null) {
        // 주소가 없는 것은 못 읽은 것과 다르다 — 사람이 할 일이 '고치기' 가 아니라 '정하기' 다.
        repos.push({ ...head, error: 'no-server' as const, proposals: [], reducedAt: null });
        continue;
      }
      try {
        const view = await reader.read(url, repo);
        for (const p of view.proposals) collectKeyIds(p, keyIds);
        repos.push({ ...head, error: null, ...view });
      } catch (err) {
        // 저장소 하나가 죽었다고 목록 전체를 비우지 않는다. 어느 저장소가 안 보이는지
        // 화면이 말할 수 있어야 하고, 나머지는 그대로 서야 한다.
        app.log.warn({ repo, err }, 'collab: repo read failed');
        repos.push({ ...head, error: 'unreachable' as const, proposals: [], reducedAt: null });
      }
    }

    return { baseUrl: fallback, repos, actors: await resolveActors(pool, keyIds) };
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
 * avcs 의 actor 키를 harkroom 계정으로 되짚는다 — 줄이 말하는 넷 중 **"누가"** 이고, 얼굴
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
