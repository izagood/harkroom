import type { Pool, PoolClient } from 'pg';

/**
 * 저장소 설정(마이그레이션 051, `docs/hub-seat.md` 「층 1 — 쓰기」).
 *
 * 이 모듈이 답하는 물음은 하나다: **이 저장소는 어디에 있는가.** 지금까지 그 답은 전역 URL
 * 하나였고, 그래서 저장소마다 다른 서버를 볼 수 없었다.
 *
 * `mode` 는 그 답의 갈래다 — `linked` 는 바깥 서버를 읽고, `hosted` 는 murmur 가 직접 띄운다.
 * **`hosted` 의 구현은 다음 단계다**(임베디드 avcs-server 의 생명주기). 지금 이 값은 저장될 뿐
 * 아무도 다르게 행동하지 않는다: 스키마와 프로세스 생명주기를 같은 PR 에서 바꾸면, 되돌릴 때
 * 둘을 함께 되돌려야 한다.
 */
export interface RepoRow {
  id: string;
  slug: string;
  mode: 'linked' | 'hosted';
  /** `null` 은 '없음' 이 아니라 **'전역을 따른다'** 다(051 주석). */
  baseUrl: string | null;
  createdAt: string;
}

const COLS = `id, slug, mode, base_url as "baseUrl", created_at as "createdAt"`;

export async function listRepos(db: Pool | PoolClient): Promise<RepoRow[]> {
  const res = await db.query(`select ${COLS} from repo order by slug`);
  return res.rows as RepoRow[];
}

export async function getRepo(db: Pool | PoolClient, slug: string): Promise<RepoRow | null> {
  const res = await db.query(`select ${COLS} from repo where slug = $1`, [slug]);
  return (res.rows[0] as RepoRow | undefined) ?? null;
}

/**
 * 채널이 가리키는데 `repo` 행이 없는 저장소를 만들어 준다.
 *
 * 바인딩은 채널 쪽에서 아무 때나 생긴다(`PATCH /channels/:id` 의 `repo`). 그때마다 설정 화면에
 * 들어가 행을 만들게 하면, 만들기 전까지 그 저장소는 협업 탭에서 **보이지 않는다** — 사람은
 * 자기가 방금 건 바인딩이 왜 아무 데도 안 나오는지 알 수 없다. 그래서 읽는 쪽이 필요할 때
 * 만든다. 기본값(`linked` · 전역 주소)은 이 저장소가 지금까지 동작하던 모양 그대로다.
 */
export async function ensureRepo(db: Pool | PoolClient, slug: string): Promise<RepoRow> {
  await db.query(
    `insert into repo (slug) values ($1) on conflict (slug) do nothing`,
    [slug],
  );
  const row = await getRepo(db, slug);
  // `do nothing` 뒤 곧바로 읽으므로 행은 반드시 있다. 없으면 슬러그가 빈 문자열이라
  // check 가 막은 것이고, 그건 부르는 쪽의 잘못이라 감춘다.
  if (!row) throw new Error(`repo not created: ${slug}`);
  return row;
}

/** 지정된 필드만 바꾼다. `baseUrl: null` 은 **'전역을 따른다'로 되돌리기**이지 지우기가 아니다. */
export async function updateRepo(
  pool: Pool, slug: string,
  patch: { mode?: 'linked' | 'hosted'; baseUrl?: string | null },
): Promise<RepoRow | null> {
  const res = await pool.query(
    `update repo set
       mode     = coalesce($2, mode),
       base_url = case when $3::bool then $4::text else base_url end
     where slug = $1
     returning ${COLS}`,
    [slug, patch.mode ?? null, patch.baseUrl !== undefined, patch.baseUrl ?? null],
  );
  return (res.rows[0] as RepoRow | undefined) ?? null;
}

/**
 * 이 저장소를 읽을 주소. **여기가 그 판정을 하는 유일한 자리다.**
 *
 * 규칙은 둘이다:
 * - 저장소가 자기 주소를 들고 있으면 그것. 없으면 전역(`fallback`).
 * - `hosted` 는 **아직 주소가 없다** — 임베디드 서버가 뜨는 다음 단계에서 murmur 자신의 주소가
 *   여기로 들어온다. 그때까지는 전역으로 떨어지므로, 지금 `hosted` 로 바꿔도 화면이 깨지지 않고
 *   다만 아무것도 달라지지 않는다.
 *
 * 두 곳에서 이 규칙을 다시 쓰면 화면과 워커가 서로 다른 서버를 본다.
 */
export function resolveRepoBaseUrl(
  repo: RepoRow | null, fallback: string | null, hostedUrl: string | null = null,
): string | null {
  // `hosted` 는 주소가 **murmur 자신**이다. 호스트가 아직 안 떴으면 `null` 이고, 그때
  // **전역으로 떨어지지 않는다** — 떨어지면 hosted 로 바꾼 저장소가 조용히 바깥 서버를 계속
  // 읽고, 화면은 그 사실을 말할 방법이 없다. 읽을 곳이 없으면 없다고 말하는 편이 낫다.
  if (repo?.mode === 'hosted') return hostedUrl;
  return repo?.baseUrl ?? fallback;
}
