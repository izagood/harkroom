import type { Pool, PoolClient } from 'pg';
import type { ChannelDoc, ChannelMemberRow, ChannelRow, NotifyLevel } from '@murmur/shared';

// #180: `created_at` 도 싣는다. 채널 디렉터리의 "생성순" 정렬을 클라이언트가 하는데,
// 목록 질의는 `order by name` 이라 순서 자체로는 생성 시각을 알 수 없다. 컬럼은 001 부터
// 있었고 마이그레이션은 필요 없다 — 안 보내던 것을 보내기 시작하는 것뿐이다.
const COLS = `id, name, topic, kind, repo, archived_at as "archivedAt", visibility, created_at as "createdAt"`;

/** `Pool` 과 `PoolClient` 가 함께 만족하는 최소 표면. 트랜잭션 안에서도 쓰라고 둔다. */
type Queryable = Pick<Pool, 'query'>;

/**
 * 채널 가시성 술어 — **이 저장소에서 가시성을 판정하는 유일한 정의다.**
 *
 * 표준 채널이 무조건 보이던 시절에는 그 전제가 여덟 자리에 흩어져 있었다: 목록·미읽음
 * 배지·검색·읽기 게이트·쓰기 게이트·이벤트 수신자, 그리고 avcs 투영 두 곳. `visibility`
 * 가 생기면 그 여덟 자리가 전부 분기점이 되므로, 술어를 복사하면 여덟 벌이 된다.
 *
 * 이 저장소는 정확히 그 사고를 이미 겪었다 — 아래 `audienceFor` 의 주석이 기록한다:
 * 같은 수신자 계산이 두 표면에 각각 있어서 한쪽만 고쳐 DM 내용이 샜다. 그래서 문자열
 * 조각 하나로 두고 모든 질의가 **같은 것을 참조**하게 한다. 한쪽만 고치는 일이 구조적으로
 * 불가능해진다.
 *
 * DM 을 따로 다루지 않는 것이 핵심이다. `kind = 'dm'` 은 언제나 `visibility` 기본값
 * 'public' 을 갖지만 첫 절의 `kind = 'standard'` 에 걸려 떨어지고, 두 번째 절(멤버십)로만
 * 통과한다 — 즉 DM 은 지금까지와 똑같이 멤버만 본다. private 채널도 **같은
 * `channel_member` 테이블**을 쓴다. 테이블을 둘로 나누면 가시성 계산이 다시 갈라진다.
 *
 * @param channel 질의 안에서 `channel` 테이블을 가리키는 별칭
 * @param accountParam 보는 사람의 계정 id 를 담은 바인드 파라미터 (예: `'$1'`)
 */
export function channelVisibleSql(channel: string, accountParam: string): string {
  return `((${channel}.kind = 'standard' and ${channel}.visibility = 'public')
     or exists (select 1 from channel_member cm_vis
                 where cm_vis.channel_id = ${channel}.id and cm_vis.account_id = ${accountParam}))`;
}

/**
 * 보관 여부 판정(#153). `channelVisibleSql` 과 **같은 이유로** 문자열 조각 하나로 둔다 —
 * 이 술어를 쓰는 곳이 메시지 POST(`channelPostGate`)와 멤버십 변경(`channelMembershipGate`,
 * #328) 둘로 늘었기 때문이다. 각자 `archived_at is not null` 을 적으면 보관의 뜻이 두 곳에
 * 살고, 한쪽만 고치는 순간 "읽기 전용인데 멤버는 바뀌는" 상태가 다시 생긴다.
 *
 * @param channel 질의 안에서 `channel` 테이블을 가리키는 별칭
 */
export function channelArchivedSql(channel: string): string {
  return `${channel}.archived_at is not null`;
}

/**
 * `pool` 이 `PoolClient` 도 받는 이유: 부트스트랩이 계정과 기본 채널을 한 트랜잭션에 묶는다
 * (`authRoutes.ts`). 그 트랜잭션의 커넥션으로 불러야 begin/commit 이 실제로 이 INSERT 를
 * 덮는다 — Pool 로 부르면 다른 커넥션의 별개 자동커밋이 된다.
 */
export async function createChannel(
  pool: Pool | PoolClient,
  input: {
    name: string; topic?: string; repo?: string | null;
    visibility?: 'public' | 'private';
    /** private 채널의 첫 멤버. public 에서는 쓰지 않는다. */
    creatorId?: string;
  },
): Promise<ChannelRow> {
  const visibility = input.visibility ?? 'public';
  const insert = async (q: Pool | PoolClient): Promise<ChannelRow> => {
    const res = await q.query(
      `insert into channel (name, topic, kind, repo, visibility)
       values ($1, $2, 'standard', $3, $4) returning ${COLS}`,
      [input.name, input.topic ?? '', input.repo ?? null, visibility],
    );
    const row = res.rows[0] as ChannelRow;
    // 멤버가 0 인 private 채널은 **아무도 열 수 없는 채널**이다 — 만든 사람조차 목록에서
    // 보지 못하고, admin 만 이름을 볼 수 있는 유령이 된다. 그래서 만든 사람이 첫 멤버다.
    if (visibility === 'private') {
      if (!input.creatorId) throw new Error('private channel requires creatorId');
      await q.query(
        `insert into channel_member (channel_id, account_id) values ($1, $2) on conflict do nothing`,
        [row.id, input.creatorId],
      );
    }
    return row;
  };
  // 채널 행과 첫 멤버는 **함께** 커밋되어야 한다(둘 사이에서 끊기면 위의 유령이 생긴다).
  // 이미 트랜잭션 안이면(부트스트랩이 `PoolClient` 를 넘긴다) 그 트랜잭션을 그대로 쓴다 —
  // 여기서 새 커넥션을 잡으면 바깥 begin/commit 이 이 INSERT 를 덮지 못한다.
  if (visibility === 'public' || 'release' in pool) return insert(pool);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const row = await insert(client);
    await client.query('commit');
    return row;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** 지정된 필드만 갱신한다. `repo: null`은 "바인딩 해제"이고, 키 자체가 없으면 "손대지 않음"이다 —
 *  둘을 구분하지 못하면 topic만 고치려다 avcs 바인딩이 조용히 끊긴다.
 * archived 는 archived_at 과 archived_by 를 함께 갱신한다 — archived_at = now() / null,
 * archived_by = actorId / null.
 * visibility 도 같은 규칙이다 — 키가 없으면 손대지 않는다. 여기서 public 을 기본값으로
 * 흘리면 admin 이 topic 만 고칠 때 private 채널이 조용히 전원에게 열린다. */
export async function updateChannel(
  pool: Pool, id: string, actorId: string,
  patch: { topic?: string; repo?: string | null; archived?: boolean; visibility?: 'public' | 'private' },
): Promise<ChannelRow | null> {
  const hasArchived = patch.archived !== undefined;
  const res = await pool.query(
    `update channel set
       topic = case when $2::bool then $3::text else topic end,
       repo  = case when $4::bool then $5::text else repo  end,
       archived_at = case when $6 is true then now() when $6 is false then null else archived_at end,
       archived_by = case when $6 is true then $7::uuid when $6 is false then null else archived_by end,
       visibility = case when $8::bool then $9::text else visibility end
     where id = $1 and kind = 'standard'
     returning ${COLS}`,
    [
      id,
      patch.topic !== undefined, patch.topic ?? null,
      patch.repo !== undefined, patch.repo ?? null,
      hasArchived ? patch.archived : null, patch.archived ? actorId : null,
      patch.visibility !== undefined, patch.visibility ?? null,
    ],
  );
  return res.rowCount ? res.rows[0] : null;
}

/**
 * 사이드바 목록. **계정을 받는다** — 채널의 존재 자체가 계정마다 다르기 때문이다(#182).
 *
 * admin 예외(`isAdmin`)를 여기에만 두는 이유: 운영(채널 정리·보관·이름 확인)은 가능해야
 * 하지만 private 의 뜻은 지켜져야 한다. 그래서 admin 은 **목록에서는 보되 메시지는 못
 * 본다** — 읽기·쓰기 게이트(`assertChannelVisible`, `channelPostGate`)에는 이 예외가
 * 없다. `MessageItem.tsx` 가 "삭제는 admin 에게 열고 수정은 안 연다"고 한 것과 같은 결의
 * 절충이다: 조정 수단은 주되, 남의 대화 내용을 읽을 권한은 주지 않는다.
 *
 * admin 예외 자체는 `channelListVisibleSql` 이 갖는다 — 채널 목록 WS 이벤트(#284)의
 * 수신자도 같은 술어를 봐야 하기 때문이다. 여기에 인라인으로 두면 두 벌이 된다.
 */
export async function listChannels(pool: Pool, accountId: string, isAdmin = false): Promise<ChannelRow[]> {
  const res = await pool.query(
    `select ${COLS} from channel c
     where c.kind = 'standard' and ${channelListVisibleSql('c', '$1', '$2::bool')}
     order by name`,
    [accountId, isAdmin],
  );
  return res.rows;
}

export async function getOrCreateDm(pool: Pool, accountIds: string[]): Promise<ChannelRow> {
  const members = [...new Set(accountIds)].sort();
  const existing = await pool.query(
    `select c.id from channel c
     join channel_member m on m.channel_id = c.id
     where c.kind = 'dm'
     group by c.id
     having array_agg(m.account_id order by m.account_id) = $1::uuid[]`,
    [members],
  );
  if (existing.rowCount) {
    const res = await pool.query(`select ${COLS} from channel where id = $1`, [existing.rows[0].id]);
    return res.rows[0];
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const created = await client.query(
      `insert into channel (kind, topic) values ('dm', '') returning ${COLS}`,
    );
    for (const id of members) {
      await client.query(`insert into channel_member (channel_id, account_id) values ($1, $2)`, [created.rows[0].id, id]);
    }
    await client.query('commit');
    return created.rows[0];
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * avcs 투영 대상. **멤버십 게이트를 통과하지 않는다** — 이건 사람의 조회가 아니라 서버가
 * 이벤트를 어디에 쓸지 고르는 일이고, 서버에는 '보는 계정'이 없다.
 *
 * 그래도 새지 않는 이유: 투영이 private 채널에 글을 쓰면 그 메시지를 읽는 사람은 여전히
 * **그 채널의 멤버뿐**이다(읽기 게이트가 같은 술어를 본다). 즉 투영은 되고, 보이는 사람이
 * 제한된다. 여기에 가시성 술어를 넣으면 반대로 private 채널만 avcs 갱신을 조용히 놓친다.
 */
export async function listBoundRepos(pool: Pool): Promise<{ repo: string; channelId: string }[]> {
  const res = await pool.query(
    `select repo, id as "channelId" from channel where repo is not null and kind = 'standard'`,
  );
  return res.rows;
}

/**
 * 채널 행 하나를 `ChannelRow` 그대로 읽는다.
 *
 * 이 함수가 따로 있는 이유: 라우트가 `select` 컬럼 목록을 **베껴 쓰면** 이 파일의 `COLS`
 * 와 갈라진다. 실측으로 그렇게 베낀 목록에 `createdAt` 이 빠져 있었고, 그 행을 실어 보낸
 * `channel.created` 를 받은 화면에서는 채널 디렉터리의 "생성순" 정렬이 그 채널만 비교할
 * 값을 잃었다 — 타입은 `any` 를 거쳐 오므로 검사에 걸리지도 않는다. 컬럼 목록의 뜻은
 * 여기 한 곳에만 둔다.
 */
export async function getChannelRow(pool: Pool, channelId: string): Promise<ChannelRow | null> {
  const res = await pool.query(`select ${COLS} from channel where id = $1`, [channelId]);
  return (res.rows[0] as ChannelRow | undefined) ?? null;
}

/**
 * 이 채널의 멤버 id. DM 과 private 채널이 **같은 테이블**을 쓰므로 함수도 하나다 — 예전
 * 이름은 `dmMemberIds` 였는데, 그 이름을 남겨 두면 private 채널에 쓸 때 "이건 DM 전용
 * 아닌가" 하고 두 번째 함수를 만들게 된다.
 */
export async function channelMemberIds(pool: Pool, channelId: string): Promise<string[]> {
  const res = await pool.query(`select account_id from channel_member where channel_id = $1`, [channelId]);
  return res.rows.map((r) => r.account_id);
}

/** 멤버 목록 화면용. handle 을 함께 준다 — 화면이 계정 목록을 따로 받아 맞출 필요가 없다. */
export async function listChannelMembers(pool: Pool, channelId: string): Promise<ChannelMemberRow[]> {
  const res = await pool.query(
    `select m.account_id as "accountId", a.handle
     from channel_member m join account a on a.id = m.account_id
     where m.channel_id = $1 order by a.handle`,
    [channelId],
  );
  return res.rows;
}

// 아래 둘은 `Pool` 대신 `Queryable` 을 받는다 — 팀을 통째로 넣는 경로(#172)가 이 두
// 함수를 **트랜잭션 클라이언트로** 부른다. 여기서 `Pool` 로 좁혀 두면 그 경로가 자기
// 멤버십 삽입을 다시 쓰게 되고, 멤버십의 뜻이 두 곳에 살게 된다.
export async function isChannelMember(db: Queryable, channelId: string, accountId: string): Promise<boolean> {
  const res = await db.query(
    `select 1 from channel_member where channel_id = $1 and account_id = $2`, [channelId, accountId],
  );
  return Boolean(res.rowCount);
}

/** 이미 멤버면 아무 일도 하지 않는다 — 초대를 두 번 눌렀다고 실패로 보이면 안 된다. */
export async function addChannelMember(db: Queryable, channelId: string, accountId: string): Promise<void> {
  await db.query(
    `insert into channel_member (channel_id, account_id) values ($1, $2) on conflict do nothing`,
    [channelId, accountId],
  );
}

/**
 * 나가기/내보내기. **마지막 멤버가 나가도 채널 행은 남는다** — 삭제는 캐스케이드 결정이
 * 필요한 별개 문제다(#155). 남은 채널은 admin 만 목록에서 보는 상태가 된다.
 */
export async function removeChannelMember(pool: Pool, channelId: string, accountId: string): Promise<boolean> {
  const res = await pool.query(
    `delete from channel_member where channel_id = $1 and account_id = $2`, [channelId, accountId],
  );
  return Boolean(res.rowCount);
}

// dm 채널은 멤버만 읽고 쓸 수 있다. standard 채널(또는 존재하지 않는 채널 id — 이후
// 단계에서 별도로 실패한다)은 항상 visible로 취급한다.
//
// #182 이후 "standard 는 항상 visible" 은 **public standard 에만** 해당한다. 판정은
// `channelVisibleSql` 하나가 하고, 이 함수는 그것을 채널 하나에 대해 물을 뿐이다.
// admin 예외는 여기에 **없다** — 목록에서 보는 것과 내용을 읽는 것은 다른 권한이다.
export async function assertChannelVisible(pool: Pool, channelId: string, accountId: string): Promise<boolean> {
  const res = await pool.query(
    `select ${channelVisibleSql('c', '$2')} as visible from channel c where c.id = $1`,
    [channelId, accountId],
  );
  // 존재하지 않는 채널 id 는 여기서 막지 않는다 — 위 주석대로 이후 단계가 404 로 답한다.
  if (!res.rowCount) return true;
  return Boolean(res.rows[0].visible);
}

/**
 * 이 채널의 이벤트를 누가 받아야 하는가. DM 은 멤버만, 그 외는 전원이다.
 *
 * 한 곳에 모으는 이유: 같은 계산이 REST 라우트(messageRoutes 의 지역 함수)와 MCP 플러그인
 * (인라인)에 각각 있었다. 이벤트 수신자 판정이 두 표면에서 갈리면 한쪽만 고쳐서 DM 내용이
 * 새거나(넓게 잡음) 실시간 갱신이 안 되는(좁게 잡음) 사고가 난다.
 */
export async function audienceFor(pool: Pool, channelId: string): Promise<'all' | string[]> {
  const channel = await pool.query(`select kind, visibility from channel where id = $1`, [channelId]);
  const row = channel.rows[0] as { kind: string; visibility: string } | undefined;
  // 존재하지 않는 채널 id 는 예전과 같이 'all' 이다 — 그런 채널의 이벤트는 애초에 생기지 않는다.
  if (!row) return 'all';
  // 여기 조건은 `channelVisibleSql` 의 첫 절과 **같은 것**이어야 한다: public standard 면
  // 전원, 그 밖(DM 과 private)은 멤버만. 한쪽만 넓히면 private 채널의 발화가 비멤버의
  // 화면에 실시간으로 뜬다 — 목록에 없는 채널의 메시지가 흘러드는 형태로.
  if (row.kind === 'standard' && row.visibility === 'public') return 'all';
  return channelMemberIds(pool, channelId);
}

/**
 * **사이드바 목록에 이 채널이 보이는가** 를 계정 하나에 대해 묻는 SQL 술어.
 *
 * `channelVisibleSql` 과 다른 질문이다 — 목록에는 admin 예외가 있다(`listChannels` 의
 * 주석: admin 은 목록에서는 보되 메시지는 못 본다). 그 예외를 여기 한 곳에 두고
 * `listChannels` 와 아래 두 수신자 함수가 **같은 것을 참조**하게 한다. 복사하면
 * "목록에 있는데 삭제됐다는 안내가 뜨는" 어긋남이 생긴다.
 *
 * @param channel 질의 안에서 `channel` 테이블을 가리키는 별칭
 * @param accountParam 보는 사람의 계정 id 를 담은 식 (예: `'$1'`, `'a.id'`)
 * @param isAdminExpr 보는 사람이 admin 인지를 담은 식 (예: `'$2::bool'`, `'a.is_admin'`)
 */
export function channelListVisibleSql(channel: string, accountParam: string, isAdminExpr: string): string {
  return `((${channel}.kind = 'standard' and ${isAdminExpr})
     or ${channelVisibleSql(channel, accountParam)})`;
}

/**
 * 채널 **목록 변경** 이벤트(`channel.created` / `channel.updated`)의 수신자(#284).
 *
 * `audienceFor`(메시지·리액션용)와 나누는 이유: 목록 이벤트가 고쳐야 하는 화면은
 * `listChannels` 가 그린 목록이고, 그 목록에는 admin 예외가 있다. `audienceFor` 를 쓰면
 * private 채널의 이름이 바뀔 때 admin 의 목록만 낡은 이름으로 남는다. 새는 방향은 없다 —
 * 페이로드(`ChannelRow`)는 admin 이 이미 `GET /channels` 로 보는 것과 같은 필드이고,
 * 메시지 본문은 여기에 없다.
 */
export async function channelListAudience(pool: Pool, channelId: string): Promise<'all' | string[]> {
  const channel = await pool.query(`select kind, visibility from channel where id = $1`, [channelId]);
  const row = channel.rows[0] as { kind: string; visibility: string } | undefined;
  // 존재하지 않는 채널 id 는 `audienceFor` 와 같이 'all' 이다.
  if (!row) return 'all';
  // public standard 는 전원이 목록에서 본다 — 계정을 훑을 필요가 없다.
  if (row.kind === 'standard' && row.visibility === 'public') return 'all';
  const res = await pool.query(
    `select a.id from account a, channel c
     where c.id = $1 and ${channelListVisibleSql('c', 'a.id', 'a.is_admin')}`,
    [channelId],
  );
  return res.rows.map((r) => r.id);
}

/**
 * 이 채널이 **목록에서 사라진** 계정들 — `channel.deleted` 의 수신자(#284).
 *
 * public→private 전환에서 필요하다: 비멤버에게 그 채널은 사라진 것이므로 삭제로 보인다.
 * `audience: 'all'` 로 보내면 **멤버도** 받아서 활성 채널이 비워지고 "삭제됐다" 안내가
 * 뜬다(멤버에게는 이름만 바뀐 사건인데). 그래서 여기서 위 술어를 **부정**해 목록에
 * 남지 않은 계정만 고른다.
 */
export async function channelListLostAudience(pool: Pool, channelId: string): Promise<string[]> {
  const res = await pool.query(
    `select a.id from account a, channel c
     where c.id = $1 and not ${channelListVisibleSql('c', 'a.id', 'a.is_admin')}`,
    [channelId],
  );
  return res.rows.map((r) => r.id);
}

export interface ChannelPrefRow {
  accountId: string;
  channelId: string;
  /**
   * 언제 음소거했는지의 기록일 뿐이다. **동작 판정에 쓰지 마라** — 알림도 배지도 훑기도
   * `notifyLevel` 만 본다(#224). 같은 사실이 두 컬럼에 살면 한쪽만 고치는 사고가 난다.
   */
  mutedAt: string | null;
  starredAt: string | null;
  notifyLevel: NotifyLevel;
  /**
   * 채널이 속한 섹션(#157). null 이면 섹션 없음(맨 아래 "기타").
   */
  section: string | null;
  /**
   * 섹션 안에서의 수동 순서(#157). null 이면 이름순 뒤에 붙는다.
   */
  sortOrder: number | null;
}

export async function updateChannelPref(
  pool: Pool, accountId: string, channelId: string,
  patch: { notifyLevel?: NotifyLevel; starred?: boolean; section?: string | null; sortOrder?: number | null },
): Promise<ChannelPrefRow | null> {
  const channel = await pool.query(`select id, kind from channel where id = $1`, [channelId]);
  if (!channel.rowCount) return null;

  if (patch.notifyLevel !== undefined) {
    // `muted_at` 도 같이 적어 둔다 — 다만 이것은 **기록일 뿐 판정에 쓰이지 않는다**(#224).
    // "언제 조용히 했나"는 수준 값으로 복원되지 않는 별개의 사실이라 남긴다.
    await pool.query(
      `insert into channel_pref (account_id, channel_id, notify_level, muted_at)
       values ($1, $2, $3, $4)
       on conflict (account_id, channel_id) do update set notify_level = $3, muted_at = $4`,
      [accountId, channelId, patch.notifyLevel, patch.notifyLevel === 'none' ? new Date() : null],
    );
  }
  if (patch.starred !== undefined) {
    await pool.query(
      `insert into channel_pref (account_id, channel_id, starred_at)
       values ($1, $2, $3)
       on conflict (account_id, channel_id) do update set starred_at = $3`,
      [accountId, channelId, patch.starred ? new Date() : null],
    );
  }
  /**
   * 섹션·순서(#157). **보낸 컬럼만 쓴다.**
   *
   * 둘을 한 문장에서 함께 쓰면 한쪽만 보낸 요청이 다른 쪽을 지운다 — 실측으로 그랬다:
   * "위로/아래로"(`sortOrder` 만 보낸다)를 누를 때마다 그 채널의 `section` 이 null 이 되어
   * 방금 옮겨 넣은 섹션에서 빠져나왔다. 옵셔널 필드에 `?? null` 을 물리면 "안 보냈다"와
   * "지워라"가 같은 뜻이 된다(docs/design.md 4절).
   *
   * `section` 의 값 가공(앞뒤 공백 제거, 빈 문자열은 null)은 `normalizeSectionName` 하나가
   * 한다 — 이름 바꾸기(#323)도 **같은 함수**를 쓴다. 복제하면 한쪽만 고쳐져 "만들 때는 되는데
   * 이름을 바꾸면 안 되는" 이름이 생긴다. 길이 검증만 라우트의 zod 가 맡는다.
   */
  if (patch.section !== undefined) {
    const sectionValue = normalizeSectionName(patch.section);
    await pool.query(
      `insert into channel_pref (account_id, channel_id, section)
       values ($1, $2, $3)
       on conflict (account_id, channel_id) do update set section = $3`,
      [accountId, channelId, sectionValue],
    );
  }
  if (patch.sortOrder !== undefined) {
    await pool.query(
      `insert into channel_pref (account_id, channel_id, sort_order)
       values ($1, $2, $3)
       on conflict (account_id, channel_id) do update set sort_order = $3`,
      [accountId, channelId, patch.sortOrder],
    );
  }
  return getChannelPref(pool, accountId, channelId);
}

export async function getChannelPref(
  pool: Pool, accountId: string, channelId: string,
): Promise<ChannelPrefRow | null> {
  const res = await pool.query(
    `select account_id as "accountId", channel_id as "channelId", muted_at as "mutedAt", starred_at as "starredAt",
            notify_level as "notifyLevel", section, sort_order as "sortOrder"
     from channel_pref where account_id = $1 and channel_id = $2`,
    [accountId, channelId],
  );
  return res.rows[0] ?? null;
}

export async function listChannelPrefs(pool: Pool, accountId: string): Promise<ChannelPrefRow[]> {
  const res = await pool.query(
    `select account_id as "accountId", channel_id as "channelId", muted_at as "mutedAt", starred_at as "starredAt",
            notify_level as "notifyLevel", section, sort_order as "sortOrder"
     from channel_pref where account_id = $1`,
    [accountId],
  );
  return res.rows;
}

/**
 * 섹션 이름의 값 가공(#157) — 앞뒤 공백을 떼고, 빈 값은 null(섹션 없음)이다.
 *
 * 생성(`updateChannelPref`)과 이름 바꾸기(`renameSection`)가 **이 함수 하나**를 쓴다.
 * 두 곳에 복제해 두면 한쪽만 고쳐져 "만들 때는 되는데 이름을 바꾸면 안 되는" 이름이 생긴다.
 * 길이 검증(1..40)은 라우트의 zod 가 맡는다.
 */
export function normalizeSectionName(value: string | null): string | null {
  const trimmed = value === null ? null : value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 한 섹션의 채널을 받은 순서 그대로 `sort_order` 0..n-1 로 다시 매긴다.
 *
 * **일부만 매기지 않는 이유**는 클라이언트의 재정렬(#157, `controller.reorderChannels`)과 같다 —
 * `sort_order` 가 null 인 행은 값이 있는 것들보다 뒤로 가므로, 절반만 매기면 나머지가 아래로
 * 쏟아진다. 합치기(#323)가 이 함수를 쓴다.
 */
async function renumberSection(
  client: Queryable, accountId: string, section: string | null, orderedChannelIds: string[],
): Promise<void> {
  for (const [index, channelId] of orderedChannelIds.entries()) {
    await client.query(
      `update channel_pref set section = $3, sort_order = $4
       where account_id = $1 and channel_id = $2`,
      [accountId, channelId, section, index],
    );
  }
}

/**
 * 섹션 이름 바꾸기(#323). 요청자의 `channel_pref` 중 `section = 옛이름` 인 행을 전부
 * 새 이름으로 한 트랜잭션에서 갱신한다. **요청자의 행만** 바뀐다 — 모든 문장이
 * `account_id` 로 걸러진다. 그 필터가 빠지면 같은 이름을 쓴 남의 섹션까지 따라 바뀐다.
 *
 * 새 이름이 이미 존재하면 **합친다** — 거절하면 사용자가 채널을 하나씩 옮겨야 한다.
 * 합칠 때는 두 섹션의 `sort_order` 가 겹치므로 묶음 전체에 `renumberSection` 으로
 * 0..n-1 을 다시 매긴다. 받는 쪽이 앞, 합쳐지는 쪽이 뒤다.
 *
 * 이름 규칙은 생성 경로와 **같은 함수**(`normalizeSectionName`)다.
 *
 * @param oldName 바꿀 섹션 이름. 빈 값은 "섹션 없음"이 아니고 오류다.
 * @param newName 새 이름. 빈 값은 null(섹션 없음)로 저장 — "섹션에서 빼기"와 같은 뜻이다.
 * @returns 새로고침된 전체 선호 목록.
 */
export async function renameSection(
  pool: Pool, accountId: string, oldName: string | null, newName: string | null,
): Promise<ChannelPrefRow[]> {
  const newSection = normalizeSectionName(newName);
  const oldSection = normalizeSectionName(oldName);
  if (oldSection === null) {
    throw new Error('old name cannot be empty');
  }
  if (oldSection === newSection) {
    return listChannelPrefs(pool, accountId);
  }

  const client = await pool.connect();
  try {
    await client.query('begin');

    /**
     * 합치는 순서를 정하려면 읽는 순서가 정해져 있어야 한다 — `order by` 가 없으면
     * Postgres 가 돌려주는 순서는 보장이 없어 같은 입력이 매번 다른 결과를 낸다.
     * 정렬 기준은 화면(`sortChannelsBySection`)과 같다: 값이 있는 것이 먼저.
     */
    const ordered = `select channel_id as "channelId" from channel_pref
       where account_id = $1 and section = $2
       order by sort_order nulls last, channel_id`;

    const oldPrefs = await client.query<{ channelId: string }>(ordered, [accountId, oldSection]);
    if (!oldPrefs.rowCount) {
      // 그런 섹션이 없으면 바꿀 것도 없다. 아무것도 쓰지 않았으니 그대로 닫는다.
      await client.query('rollback');
      return listChannelPrefs(pool, accountId);
    }

    if (newSection === null) {
      // "섹션에서 빼기"와 같은 뜻이다. `sort_order` 는 건드리지 않는다 — #157 의
      // 빼기도 순서 값을 남긴다(섹션 안에서만 뜻이 있으니 다시 넣으면 되살아난다).
      await client.query(
        `update channel_pref set section = null where account_id = $1 and section = $2`,
        [accountId, oldSection],
      );
    } else {
      const existing = await client.query<{ channelId: string }>(ordered, [accountId, newSection]);
      if (existing.rowCount) {
        await renumberSection(
          client, accountId, newSection,
          [...existing.rows, ...oldPrefs.rows].map((r) => r.channelId),
        );
      } else {
        // 받는 쪽이 없으면 겹칠 `sort_order` 도 없다 — 이름만 갈아 끼우고 순서는 그대로 둔다.
        await client.query(
          `update channel_pref set section = $3 where account_id = $1 and section = $2`,
          [accountId, oldSection, newSection],
        );
      }
    }

    await client.query('commit');
    return listChannelPrefs(pool, accountId);
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 글을 쓸 수 있는가 — 가시성과 보관 여부를 **한 질의로** 함께 본다.
 *
 * 둘을 따로 물으면 메시지 POST 한 번에 왕복이 하나 늘어난다. 이건 이 앱에서 가장 자주
 * 도는 경로이고, 보관 여부는 이미 읽고 있는 `channel` 행에 같이 들어 있다 — 같은 행을
 * 두 번 읽을 이유가 없다.
 *
 * 편집·삭제·리액션에는 쓰지 않는다. 보관된 채널에서도 잘못 올라간 것을 치울 수 있어야
 * 하고, 그 경로까지 닫으면 admin 에게 조정 수단이 없어진다.
 */
export async function channelPostGate(
  /**
   * `Pool` 뿐 아니라 **트랜잭션 클라이언트**도 받는다(#222). 예약 발송 sweep 은 행을
   * `for update skip locked` 로 잡은 트랜잭션 안에서 이 술어를 물어야 하는데, 그때
   * `pool` 로 물으면 **커넥션을 하나 더** 잡는다 — 락을 쥔 채 풀을 기다리는 모양이라
   * 풀이 마르면 그대로 교착이다. 쥐고 있는 클라이언트로 묻게 열어 둔다.
   */
  db: Queryable, channelId: string, accountId: string,
): Promise<'ok' | 'forbidden' | 'archived'> {
  const res = await db.query(
    `select ${channelVisibleSql('c', '$2')} as visible,
            ${channelArchivedSql('c')} as archived
     from channel c where c.id = $1`,
    [channelId, accountId],
  );
  const row = res.rows[0] as { visible: boolean; archived: boolean } | undefined;
  if (!row) return 'ok';
  // 쓰기 게이트도 읽기와 **같은 술어**를 본다. public 채널은 멤버가 아니어도 쓸 수 있고
  // (멤버십은 구독일 뿐이다), private 채널은 비멤버에게 403 이다 — admin 예외 없다.
  if (!row.visible) return 'forbidden';
  return row.archived ? 'archived' : 'ok';
}

/**
 * 손으로 멤버십을 바꿀 수 있는 채널인가(#328). **추가와 제거 둘 다**가 이 게이트를 탄다.
 *
 * 제거까지 막는 이유: 보관은 "읽기 전용"이라는 결정(#153)이고 멤버십 변경은 쓰기다. 추가만
 * 막으면 보관된 채널의 멤버 목록이 계속 움직이고, `#322` 의 퇴장 시스템 메시지까지 남아
 * 읽기 전용이어야 할 채널에 새 메시지가 생긴다.
 *
 * 보관 판정은 `channelPostGate`(#153)와 **같은 `channelArchivedSql`** 을 본다 — 판정을
 * 베끼면 곧 갈라진다.
 *
 * DM 은 `getOrCreateDm` 이 참여자를 정하는 채널이다. 사람이 손으로 넣고 빼는 자리가
 * 아니므로 `kind = 'dm'` 은 거절한다 — 거절의 모양은 `#172` 의 `channel_is_public` 을
 * 따른다(그 채널에는 이 조작에 할 일이 없다는 뜻이라 400 이다).
 *
 * 가시성은 **여기서 보지 않는다** — 호출부마다 다르기 때문이다. 초대는
 * `assertChannelVisible`(#156), 제거는 자기 자신인지에 따라 갈린다. 그 판정을 여기 끌어오면
 * 라우트가 이미 내린 결정을 두 번째 자리에서 다시 정하게 된다.
 *
 * 존재하지 않는 채널은 `'not_found'` 로 **명시해서** 돌려준다. 여기서 `'ok'` 로 삼키면
 * 초대 경로가 `channel_member` 의 FK 위반으로 500 을 답한다 — 잘못된 입력이 서버 오류가 된다.
 */
export async function channelMembershipGate(
  db: Queryable, channelId: string,
): Promise<'ok' | 'not_found' | 'archived' | 'dm'> {
  const res = await db.query(
    `select c.kind, ${channelArchivedSql('c')} as archived from channel c where c.id = $1`,
    [channelId],
  );
  const row = res.rows[0] as { kind: string; archived: boolean } | undefined;
  if (!row) return 'not_found';
  if (row.archived) return 'archived';
  if (row.kind === 'dm') return 'dm';
  return 'ok';
}

/**
 * 채널 문서 조회(#188). 아직 저장된 것이 없으면 **본문이 빈 문서**를 준다 — 404 가 아니다.
 *
 * "문서가 없다"와 "문서가 비어 있다"는 사람에게 같은 화면이므로, 채널을 만들 때마다 빈 행을
 * 심어 두지 않고 읽는 쪽에서 그 모양으로 맞춘다. 다만 `updatedBy`·`updatedAt` 은
 * **`null` 로 둔다** — 지금 시각과 보는 사람으로 채우면 아무도 쓴 적 없는 문서를 내가
 * 방금 고친 것처럼 보여 주고, 그 가짜 시각이 `expectedUpdatedAt` 으로 돌아오면 낙관적
 * 동시성 검사가 무엇과 비교하는지 알 수 없게 된다.
 *
 * 가시성은 여기서 보지 않는다 — 호출부(`channelRoutes`, `mcpPlugin`)가
 * `assertChannelVisible`/`channelPostGate` 로 먼저 검사한다. 채널이 존재하지 않는 경우도
 * 호출부가 404 로 답한다(`assertChannelVisible` 이 그렇게 쓰이도록 만들어져 있다).
 */
export async function getChannelDoc(pool: Pool, channelId: string): Promise<ChannelDoc> {
  const res = await pool.query<ChannelDoc>(
    `select d.channel_id as "channelId", d.body, d.updated_by as "updatedBy",
            d.updated_at as "updatedAt"
     from channel_doc d where d.channel_id = $1`,
    [channelId],
  );
  const row = res.rows[0];
  if (!row) return { channelId, body: '', updatedBy: null, updatedAt: null };
  // pg 가 timestamptz 를 Date 로 준다. 계약(`ChannelDoc`)은 문자열이므로 여기서 맞춘다 —
  // 클라이언트가 되돌려 보내는 `expectedUpdatedAt` 과 같은 값이어야 한다.
  return { ...row, updatedAt: new Date(row.updatedAt!).toISOString() };
}

/**
 * 채널 문서 저장(#188) — **낙관적 동시성은 한 문장 안에서 판정한다.**
 *
 * 읽고 나서 쓰면(select 로 `updated_at` 을 확인한 뒤 update) 두 요청이 같은 기대값으로
 * 동시에 검사를 통과하고 둘 다 쓴다. 그러면 나중 것이 앞선 것을 조용히 덮어쓰는데, 그것이
 * 바로 이 기능이 막으려던 사고다. 그래서 `on conflict ... do update ... where` 로 조건을
 * **쓰기 문장 자체에** 붙인다. 조건이 틀리면 0 행이 돌아오고, 그때가 stale 이다.
 *
 * `expectedUpdatedAt` 이 `null` 인 것은 "검사하지 마라"가 아니라 **"아직 문서가 없다고
 * 믿는다"**다. 옵셔널을 "검사 생략"으로 읽으면 필드를 빼기만 해도 낙관적 동시성이 사라진다 —
 * 조용히 덮어쓰기를 막으려고 만든 장치가 필드 하나로 꺼지면 안 된다. 그래서 `null` 이면
 * insert 만 성공하고, 이미 행이 있으면(`on conflict` 로 들어와 `updated_at = null` 비교가
 * 거짓) stale 이다.
 */
export async function updateChannelDoc(
  pool: Pool, channelId: string, actorId: string,
  body: string, expectedUpdatedAt: Date | null,
): Promise<{ ok: ChannelDoc } | { stale: ChannelDoc }> {
  const res = await pool.query(
    `insert into channel_doc (channel_id, body, updated_by, updated_at)
     values ($1, $2, $3, now())
     on conflict (channel_id) do update
       set body = excluded.body, updated_by = excluded.updated_by, updated_at = now()
       where channel_doc.updated_at = $4::timestamptz
     returning channel_id`,
    [channelId, body, actorId, expectedUpdatedAt],
  );
  // 0 행이면 행이 이미 있는데 기대값이 어긋난 것이다. 현재 본문을 함께 돌려줘야 사람이
  // 무엇이 달라졌는지 보고 다시 편집할 수 있다 — 조용히 버리지도, 덮어쓰지도 않는다.
  if (!res.rowCount) return { stale: await getChannelDoc(pool, channelId) };
  return { ok: await getChannelDoc(pool, channelId) };
}

/**
 * 보관된 표준 채널을 영구히 삭제한다(#155).
 *
 * **지우는 대상은 스키마에게 물어서 정했다.** 마이그레이션 전체에서
 * `references channel(id)` 와 `references message(id)` 를 찾아 목록을 만들었고,
 * `channelDelete.test.ts` 가 같은 것을 `information_schema` 로 다시 세어 이 목록과
 * 어긋나면 빨개진다 — 다음 마이그레이션이 새 참조를 더할 때 알려 주는 자리다.
 *
 * 목록(참조 열과 처리 방식):
 *   - `message_pin`      (channel_id, message_id)      명시적 삭제
 *   - `channel_read`     (channel_id)                  명시적 삭제
 *   - `channel_member`   (channel_id)                  명시적 삭제
 *   - `channel_pref`     (channel_id, cascade)         명시적 삭제(cascade 에 기대지 않는다)
 *   - `channel_doc`      (channel_id)                  명시적 삭제 — cascade 없음(#188)
 *   - `inbox`            (message_id)                  명시적 삭제 — cascade 없음
 *   - `idempotency_key`  (message_id, channel_id)      명시적 삭제 — cascade 없음
 *   - `work_thread`      (thread_root_message_id)      명시적 삭제 — cascade 없음
 *   - `saved_message`    (message_id)                  명시적 삭제 — cascade 없음(#219)
 *   - `message_reaction` (message_id, cascade)         message 삭제로 함께 사라진다
 *   - `attachment`       (message_id, cascade)         message 삭제로 함께 사라진다
 *   - `message`          (channel_id, thread_root_id)  명시적 삭제
 *   - `channel`          (자신)                        마지막
 *
 * `inbox`·`idempotency_key`·`work_thread` 를 빠뜨리면 **멘션이 하나라도 있거나 재시도 키가
 * 하나라도 붙은 채널**의 삭제가 FK 위반으로 터진다. 처음 판이 그랬고, 회귀선이 API 로 볼 수
 * 있는 것만 확인해서 초록이었다.
 *
 * FK 를 `on delete cascade` 로 바꾸지 않는 이유: cascade 를 스키마에 박으면 무엇이 함께
 * 사라지는지가 코드 어디에도 안 적힌다 — 나중에 새 테이블이 `channel_id` 를 참조할 때 그
 * 테이블도 조용히 같이 지워지고, 아무도 그것을 결정한 적이 없다. 지우는 순서와 대상이 이
 * 함수에 적혀 있는 것이 이 작업의 산출물이다.
 *
 * 계정(`009_agent_disable.sql`)이 반대 결정(소프트 비활성화)을 내린 이유와 채널이 다른 이유:
 * 계정은 남의 메시지에 **작성자로 남는다** — 지우면 그 메시지가 작성자를 잃는다. 채널은 그
 * 안의 것을 다 지우면 밖에서 가리키는 것이 남지 않는다.
 *
 * 파일 삭제는 **행 삭제 이후**다. 업로드는 "파일 먼저, 행 나중"이지만(`attachmentRoutes.ts`:
 * 반대 순서면 가리키는 파일이 없는 행이 남는다) 삭제는 그 반대가 안전하다 — 행을 먼저
 * 지우면 파일 삭제가 실패해도 남는 것은 고아 파일(나중에 치울 수 있다)이고, 파일을 먼저
 * 지우면 그 사이 읽는 요청이 '깨진 첨부'를 본다.
 *
 * 파일 삭제 실패는 **트랜잭션을 되돌리지 않는다** — 고아 파일은 무해하고, 되돌리면 사람은
 * 지웠다고 믿는데 채널이 살아 있다.
 *
 * 판정과 삭제를 **한 트랜잭션·한 연결에서** 한다. 판정을 풀에서 따로 하면 다른 연결이라
 * 그 사이 보관이 풀려도 삭제가 그대로 나간다. `for update` 로 채널 행을 잡는 이유가 그것이다.
 */
export async function deleteChannel(
  pool: Pool, channelId: string,
  storage?: { remove(key: string): Promise<void> },
): Promise<
  { name: string; messageCount: number; attachmentCount: number; storageKeys: string[] }
  | 'not_archived' | 'not_found' | 'is_dm'
> {
  const client = await pool.connect();
  let committed = false;
  let storageKeys: string[] = [];
  let result:
    | { name: string; messageCount: number; attachmentCount: number; storageKeys: string[] }
    | 'not_archived' | 'not_found' | 'is_dm';
  try {
    await client.query('begin');

    // 판정 대상 행을 잠근다 — 판정과 삭제 사이에 보관이 풀리는 것을 막는다.
    const channel = await client.query(
      `select id, name, kind, archived_at from channel where id = $1 for update`,
      [channelId],
    );
    if (!channel.rowCount) {
      await client.query('rollback');
      return 'not_found';
    }
    const row = channel.rows[0] as { id: string; name: string; kind: string; archived_at: string | null };
    // DM 은 지울 수 없다 — 표준 채널만 대상이다.
    if (row.kind !== 'standard') {
      await client.query('rollback');
      return 'is_dm';
    }
    // 보관이 선행 조건이다. 삭제는 되돌릴 수 없는데 채널 메뉴는 한 번의 클릭이므로,
    // "그만 쓰기로 했다"와 "영구히 없앤다"를 두 번의 의도적 조작으로 가른다.
    if (!row.archived_at) {
      await client.query('rollback');
      return 'not_archived';
    }

    // 지울 파일 키를 행 삭제 **전에** 읽는다 — 지운 뒤에는 물을 곳이 없다.
    const keys = await client.query<{ storage_key: string }>(
      `select a.storage_key from attachment a
       join message m on m.id = a.message_id
       where m.channel_id = $1`,
      [channelId],
    );
    storageKeys = keys.rows.map((r) => r.storage_key);

    // 감사에 남길 개수. 삭제 후에는 무엇이 사라졌는지 물을 곳이 없으니 규모라도 남아야
    // "실수로 큰 채널을 지웠다"를 나중에 알 수 있다.
    const counted = await client.query<{ cnt: number }>(
      `select count(*)::int as cnt from message where channel_id = $1`,
      [channelId],
    );
    const messageCount = counted.rows[0]!.cnt;
    const attachmentCount = storageKeys.length;

    // 아래 순서는 위 목록과 같다. 메시지를 참조하는 것부터 지우고, 채널을 참조하는 것,
    // 마지막에 채널 자신이다.
    //
    // inbox: message_id 참조, cascade 없음. 멘션이 있는 채널이 여기서 걸렸다.
    await client.query(
      `delete from inbox where message_id in (select id from message where channel_id = $1)`,
      [channelId],
    );
    // idempotency_key: message_id·channel_id 둘 다 참조, cascade 없음. channel_id 로 지우면
    // 둘 다 정리된다(같은 채널의 메시지만 가리킨다).
    await client.query(`delete from idempotency_key where channel_id = $1`, [channelId]);
    // work_thread: thread_root_message_id 참조, cascade 없음. avcs 투영이 만든다.
    await client.query(
      `delete from work_thread
       where thread_root_message_id in (select id from message where channel_id = $1)`,
      [channelId],
    );
    // saved_message: message_id 참조, cascade 없음(#219). 채널이 사라지면 담아 둔 자리도
    // 사라진다 — "삭제됨"으로 남기는 것은 **메시지** 삭제이고(#219 결정 3), 채널 삭제는
    // 그 채널이 있었다는 사실 자체를 지우는 별개의 작업이다(#155).
    await client.query(
      `delete from saved_message
       where message_id in (select id from message where channel_id = $1)`,
      [channelId],
    );
    // message_pin: channel_id·message_id 참조.
    await client.query(`delete from message_pin where channel_id = $1`, [channelId]);
    // channel_read: channel_id 참조.
    await client.query(`delete from channel_read where channel_id = $1`, [channelId]);
    // channel_member: channel_id 참조.
    await client.query(`delete from channel_member where channel_id = $1`, [channelId]);
    // channel_pref: channel_id 참조(cascade 지만 명시적으로 지운다 — 목록이 코드에 남아야 한다).
    await client.query(`delete from channel_pref where channel_id = $1`, [channelId]);
    // channel_doc: channel_id 참조, cascade 없음(#188). 문서가 하나라도 있는 채널의 삭제가
    // 여기 없으면 FK 위반으로 터진다 — `channelDelete.test.ts` 가 스키마를 다시 세어
    // 이 목록의 누락을 잡아 줬다(#155 가 세운 그 자리가 실제로 작동했다).
    await client.query(`delete from channel_doc where channel_id = $1`, [channelId]);
    // scheduled_message: channel_id·thread_root_id·sent_message_id 참조, cascade 없음(#222).
    // 아직 나가지 않은 예약도 함께 사라진다 — 채널이 없어졌으니 보낼 곳이 없고, 남겨 두면
    // sweep 이 매번 없는 채널을 집어 든다. **message 보다 먼저** 지워야 한다:
    // `sent_message_id` 가 이 채널의 메시지를 가리키기 때문이다.
    await client.query(`delete from scheduled_message where channel_id = $1`, [channelId]);
    // message: channel_id 참조. attachment·message_reaction 은 cascade 로 함께 사라진다.
    // thread_root_id 자기 참조는 한 문장 안에서 부모·자식을 함께 지우므로 문제가 없다.
    await client.query(`delete from message where channel_id = $1`, [channelId]);
    // channel: 마지막.
    await client.query(`delete from channel where id = $1`, [channelId]);

    await client.query('commit');
    committed = true;
    result = { name: row.name ?? '', messageCount, attachmentCount, storageKeys };
  } catch (err) {
    if (!committed) await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // 커밋 뒤에 파일을 지운다. 실패는 삼키지만 되돌리지 않는다 — 위 주석의 이유다.
  if (storage && storageKeys.length > 0) {
    await Promise.allSettled(storageKeys.map((key) => storage.remove(key)));
  }
  return result;
}
