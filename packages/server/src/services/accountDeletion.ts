import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { revokeAllPats } from './agents.js';

/**
 * 사람이 **자기 계정을 지운다**(`DELETE /accounts/me`). 되돌리는 길은 없다.
 *
 * 행은 지우지 않는다 — 에이전트 삭제(`deleteAgentAccount`)와 같은 이유로 `message.author_id` 가
 * 이 행을 가리키고, 대화 이력은 그 사람 혼자의 것이 아니다. 대신 **그 사람을 알아볼 값**을 지운다:
 * 이름·아바타(파일 바이트까지)·로그인 id·비밀번호. handle 은 `deleted-<id 앞 8자>` 로 바꾼다 —
 * 본문은 `<@id>` 로 이름을 풀므로 지난 글은 깨지지 않고, 옛 handle 은 다른 사람이 쓸 수 있게 풀린다.
 *
 * 막는 자리는 `deleted_at` 이다 — 세션 인증이 그것을 본다. `disabled_at` 도 함께 찍고 로그인은
 * 둘 다 본다(두 번째 그물). 세션·PAT·오퍼레이터를 같은 트랜잭션에서 폐기하므로 이미 열린 연결도
 * 다음 재검증에서 끊긴다. 세션을 지우면 푸시 기기(092)도 cascade 로 지워지지만, 직접도 지운다.
 *
 * 거절하는 경우(`blocked`) — 지우는 사람이 주인인 에이전트가 남아 있을 때(그 에이전트는 자기
 * 자격증명으로 계속 돈다: 먼저 넘기거나 지워야 한다), 그리고 마지막 관리자일 때(워크스페이스를
 * 관리할 사람이 사라진다). 같이 지우지 않는다 — 무엇을 잃는지 사람이 보고 정해야 한다.
 */
/** 지운 사람의 표시 이름. `display_name` 은 not null 이라 비울 수 없다 — 화면이 현지화할 수 있게 고정 값이다. */
export const DELETED_DISPLAY_NAME = 'Deleted user';

/** 아바타 **파일**은 커밋 뒤에 호출부가 `storage.remove` 로 지운다(트랜잭션 안에서 지우면 롤백해도 파일은 돌아오지 않는다). */
export type AccountDeletionBlock =
  | { code: 'owns_agents'; agents: { id: string; handle: string }[] }
  | { code: 'last_admin' };

export type AccountDeletionResult =
  | { ok: true; handle: string; avatarStorageKey: string | null }
  | { ok: false; block: AccountDeletionBlock };

export async function deleteHumanAccount(pool: Pool, accountId: string): Promise<AccountDeletionResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // 같은 사람의 두 요청·관리자 둘의 동시 삭제가 서로의 판정을 못 보고 둘 다 지나가지 않게 잠근다.
    const me = await client.query<{ handle: string; role: string; avatarStorageKey: string | null }>(
      `select a.handle, a.role, att.storage_key as "avatarStorageKey"
         from account a left join attachment att on att.id = a.avatar_attachment_id
        where a.id = $1 and a.kind = 'human' and a.deleted_at is null
        for update of a`, [accountId]);
    const row = me.rows[0];
    if (!row) throw new Error('account not found');
    const { handle, role, avatarStorageKey } = row;

    const owned = await client.query<{ id: string; handle: string }>(
      `select a.id, a.handle from agent_config c join account a on a.id = c.account_id
        where c.owner_account_id = $1 and a.kind = 'agent' and a.deleted_at is null
        order by a.handle`, [accountId]);
    if (owned.rowCount) {
      await client.query('rollback');
      return { ok: false, block: { code: 'owns_agents', agents: owned.rows } };
    }

    if (role === 'owner' || role === 'admin') {
      // 관리자 행들을 잠그고 센다 — 두 관리자가 동시에 자기를 지우면 한쪽만 지나가야 한다.
      const others = await client.query(
        `select 1 from account
          where kind = 'human' and id <> $1 and role in ('owner', 'admin')
            and deleted_at is null and disabled_at is null
          for update`, [accountId]);
      if (!others.rowCount) {
        await client.query('rollback');
        return { ok: false, block: { code: 'last_admin' } };
      }
    }

    const short = accountId.replace(/-/g, '').slice(0, 8);
    await client.query(
      `update account
          set deleted_at = now(), disabled_at = coalesce(disabled_at, now()),
              handle = $2, display_name = $4, avatar_attachment_id = null,
              login_id = $3, password_hash = null
        where id = $1`,
      [accountId, `deleted-${short}`, `deleted-${randomBytes(16).toString('hex')}`, DELETED_DISPLAY_NAME]);
    await client.query(`delete from push_device where account_id = $1`, [accountId]);
    await client.query(`delete from session where account_id = $1`, [accountId]);
    await revokeAllPats(client, accountId);
    // 오퍼레이터 토큰은 주인 계정을 보지 않고 선다 — 여기서 폐기하지 않으면 지운 사람의 기기가 계속 붙는다.
    await client.query(`delete from agent_assignment where operator_id in (select id from operator where owner_account_id = $1)`, [accountId]);
    await client.query(`update operator set revoked_at = now() where owner_account_id = $1 and revoked_at is null`, [accountId]);
    await client.query('commit');
    return { ok: true, handle, avatarStorageKey };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
