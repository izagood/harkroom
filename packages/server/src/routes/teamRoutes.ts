import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { HANDLE_PATTERN } from '@murmur/shared';
import {
  listTeams, getTeam, getTeamByName, createTeam, updateTeamName, deleteTeam,
  listTeamMembers, addAgentToTeam, removeAgentFromTeam, addTeamToChannel,
} from '../services/teams.js';
import { recordAudit } from '../audit.js';
import { assertChannelVisible } from '../services/channels.js';

/**
 * 에이전트 팀(#172)의 관리 표면.
 *
 * 팀 이름은 **계정 handle·집합 handle 과 같은 네임스페이스**다(집합 #230 과 같은 결정).
 * 그래서 문법도 계정과 같은 것을 봐야 한다 — `HANDLE_PATTERN` 을 쓰는 이유다. 여기
 * 리터럴로 다시 적으면 계정 쪽 문법이 바뀔 때 한쪽만 따라가고, `@foo` 가 어느 쪽으로
 * 갈리는지 알 수 없게 된다. 멘션 해석 자체는 이 작업의 범위가 아니고, 이름 예약만 한다.
 */
const nameSchema = z.string().regex(new RegExp(`^${HANDLE_PATTERN}$`));

export async function registerTeamRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const teamParam = z.object({ id: z.string().uuid() });
  const memberParams = z.object({ id: z.string().uuid(), accountId: z.string().uuid() });

  /**
   * 목록은 **누구나** 본다. 팀을 정하는 것은 admin 이지만, "이 채널에 어느 팀을 넣을까"를
   * 고르는 사람은 그 채널의 멤버라 목록을 읽을 수 있어야 한다(아래 채널 추가 라우트가
   * admin 전용이 아닌 것과 같은 이유).
   */
  app.get('/teams', { preHandler: app.requireAccount }, async () => ({
    teams: await listTeams(pool),
  }));

  app.post('/teams', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { name } = z.object({ name: nameSchema }).parse(req.body);

    // 먼저 읽는 것은 **사유를 갈라 말하기 위해서**다 — 팀과 겹쳤는지 계정·집합과 겹쳤는지
    // 운영자가 알아야 다음 행동이 갈린다. 판정의 근거는 이 읽기가 아니라 `createTeam` 의
    // 한 문장(세 겹침 확인 + 삽입)과 unique 인덱스다.
    if (await getTeamByName(pool, name)) {
      return reply.code(400).send({
        error: { code: 'name_taken', message: 'a team with this name already exists' },
      });
    }

    const team = await createTeam(pool, name, req.account!.id);
    if (!team) {
      return reply.code(400).send({
        error: { code: 'name_taken', message: 'an account or handle group already has this name' },
      });
    }
    await recordAudit(pool, {
      action: 'team.created', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: team.id, detail: { handle: name },
    }, req);
    return reply.code(201).send(team);
  });

  app.patch('/teams/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = teamParam.parse(req.params);
    const { name } = z.object({ name: nameSchema }).parse(req.body);

    const result = await updateTeamName(pool, id, name);
    if (!result.ok) {
      if (result.reason === 'not_found') {
        return reply.code(404).send({ error: { code: 'not_found', message: 'no such team' } });
      }
      return reply.code(400).send({
        error: { code: 'name_taken', message: 'this name is already taken' },
      });
    }
    await recordAudit(pool, {
      action: 'team.updated', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { handle: name },
    }, req);
    return result.team;
  });

  app.delete('/teams/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = teamParam.parse(req.params);
    // 지운 행을 받아 온다 — 감사에 이름을 남겨야 하고, 지운 뒤에는 물어볼 곳이 없다.
    const deleted = await deleteTeam(pool, id);
    if (!deleted) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such team' } });
    }
    await recordAudit(pool, {
      action: 'team.deleted', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { handle: deleted.name },
    }, req);
    return reply.code(204).send();
  });

  app.get('/teams/:id', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = teamParam.parse(req.params);
    const team = await getTeam(pool, id);
    if (!team) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such team' } });
    }
    return { team, members: await listTeamMembers(pool, id) };
  });

  app.put('/teams/:id/members/:accountId', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id, accountId } = memberParams.parse(req.params);

    // 팀이 없으면 FK 위반으로 500 이 된다 — 잘못된 입력을 서버 오류로 답하면 호출부가
    // 재시도할 대상인지 아닌지 구분하지 못한다(`#156` 의 초대 라우트와 같은 이유).
    if (!(await getTeam(pool, id))) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such team' } });
    }

    const account = await pool.query(`select kind, handle from account where id = $1`, [accountId]);
    if (!account.rowCount) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such account' } });
    }
    // 사람 계정은 팀에 넣지 않는다. 화면에서만 막으면 안 되고 서버가 강제해야 한다 —
    // 집합(#230)이 에이전트를 거절하는 것과 정확히 대칭이다.
    if (account.rows[0].kind !== 'agent') {
      return reply.code(400).send({ error: { code: 'not_an_agent', message: 'only agents can join a team' } });
    }

    await addAgentToTeam(pool, id, accountId);
    await recordAudit(pool, {
      action: 'team.member.added', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { handle: account.rows[0].handle },
    }, req);
    return { members: await listTeamMembers(pool, id) };
  });

  app.delete('/teams/:id/members/:accountId', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id, accountId } = memberParams.parse(req.params);

    if (!(await getTeam(pool, id))) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such team' } });
    }

    const removed = await removeAgentFromTeam(pool, id, accountId);
    if (removed) {
      const account = await pool.query(`select handle from account where id = $1`, [accountId]);
      await recordAudit(pool, {
        action: 'team.member.removed', actorId: req.account!.id, actorHandle: req.account!.handle,
        target: id, detail: { handle: account.rows[0]?.handle },
      }, req);
    }
    return { members: await listTeamMembers(pool, id) };
  });

  /**
   * 팀을 채널에 넣는다.
   *
   * **게이트는 `#156` 의 초대와 같은 것이다** — `requireAdmin` 이 아니라
   * `assertChannelVisible`. 이 조작은 "팀원을 한 명씩 초대하는 것"과 같은 사건이고,
   * `#156` 은 그 게이트를 이렇게 정했다: private 채널에서는 그 술어가 곧 멤버십이라
   * "남의 private 채널에 사람을 밀어 넣기"가 막힌다. admin 이라는 이유로 열지 않는다 —
   * admin 도 자기가 없는 private 채널에는 못 부른다. 여기만 admin 으로 열면 그 결정이
   * 팀이라는 우회로로 무너진다(초판이 그랬고, `assertChannelVisible` 은 import 만 되어
   * 있고 쓰이지 않았다).
   *
   * public 채널은 **400 `channel_is_public`** 이다. public 채널에는 멤버십이 없으므로
   * (`#156`: 멤버십은 구독일 뿐이다) 이 조작에 할 일이 없다 — 뜻이 없는 조작을 조용히
   * 성공시키면 화면은 "넣었다"고 말하고 아무 일도 일어나지 않는다.
   */
  app.post('/channels/:id/teams/:teamId/add', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id, teamId } = z.object({
      id: z.string().uuid(), teamId: z.string().uuid(),
    }).parse(req.params);

    const channel = await pool.query(`select visibility from channel where id = $1`, [id]);
    if (!channel.rowCount) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such channel' } });
    }
    if (channel.rows[0].visibility === 'public') {
      return reply.code(400).send({ error: { code: 'channel_is_public', message: 'a public channel has no membership' } });
    }
    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this channel' } });
    }

    const team = await getTeam(pool, teamId);
    if (!team) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such team' } });
    }

    const result = await addTeamToChannel(pool, id, teamId);

    // detail 에 넣은 handle 을 전부 적지 않는다 — 팀이 클수록 detail 이 부풀고, 누가
    // 멤버가 됐는지는 멤버 목록이 답한다. 여기 남길 사실은 "어느 팀을 넣었고 규모가
    // 어땠나"다.
    await recordAudit(pool, {
      action: 'channel.team.added', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { teamHandle: team.name, added: result.added.length, skipped: result.skipped.length },
    }, req);

    return result;
  });
}
