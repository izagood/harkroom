//! 기억 조각 채우기(기억 벡터 V3) — 조각이 없거나 낡은 기억을 골라 임베딩해 `agent_memory_chunk` 에 넣는다. 처음 켰을 때의
//! 백필도 같은 길이다(다 「없는 것」이다).
//!
//! - 낡음 = 지금 본문의 해시([`crate::mem_chunk::CHUNK_VERSION`]·이름·요약·본문)·모델·차원이 같은 `body` 조각이 없음. 사건을 놓쳐도
//!   다음 tick 이 잡으므로 쓰는 길(set·merge·restore)은 이 표를 모른다.
//! - `core` 와 숨긴 기억(`flagged_at`)은 임베딩하지 않고, 이미 있으면 지운다. 보관한 기억·journal 은 남긴다(직접 검색·중복 검사용).
//! - 임베딩을 기다리는 동안 트랜잭션을 열지 않는다. 넣을 때 해시를 다시 보아 그 사이 바뀐 기억은 버린다(다음 tick).
//! - 서비스가 준비 전이면 아무것도 안 한다. 글·벡터·slug 는 로그에 남기지 않는다(수만).
use super::{GateResult, Side, run_gated};
use crate::embed::{BATCH_SIZE, EmbedError, Embedder};
use crate::mem_chunk::{CHUNK_VERSION, Chunk, chunks};
use sqlx::PgPool;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

pub const MEMORY_EMBED_INTERVAL: Duration = Duration::from_secs(30);
/// tick 하나가 채우는 기억 수.
pub const DOCS_PER_TICK: i64 = 50;
/// 서비스가 거절한 글을 외워 두는 수 — 넘치면 비우고 다시 해 본다.
const FAILED_MAX: usize = 256;

/// 이 루프가 쓰는 권한 — 운영 GRANT 와 같아야 한다. 표가 없으면(pgvector 없음) 보기 전에 [`table_exists`] 로 거른다.
pub const MEMORY_EMBED_PRIVILEGES: &[(&str, &str)] = &[
    ("agent_memory", "SELECT"),
    ("agent_memory_chunk", "SELECT"),
    ("agent_memory_chunk", "INSERT"),
    ("agent_memory_chunk", "DELETE"),
];

/// 문서 해시 — `$1` 은 조각 규칙의 판. 쓰는 세 문장이 같은 식이어야 한다.
macro_rules! doc_hash {
    () => {
        "encode(sha256(convert_to(concat_ws(E'\\x1f', $1::text, m.slug, coalesce(m.description, ''), m.value), 'UTF8')), 'hex')"
    };
}

const STALE_SQL: &str = concat!(
    "select account_id, slug, description, value, hash from (select m.account_id::text as account_id, m.slug, m.description, m.value, ",
    doc_hash!(),
    " as hash, m.updated_at from agent_memory m \
     where m.slug <> 'core' and m.flagged_at is null) d \
     where not (d.hash = any($4)) and not exists (select 1 from agent_memory_chunk c \
       where c.account_id = d.account_id::uuid and c.slug = d.slug and c.source = 'body' \
         and c.doc_hash = d.hash and c.model = $2 and c.dim = $3) \
     order by d.updated_at desc limit $5"
);

const INSERT_SQL: &str = concat!(
    "insert into agent_memory_chunk \
       (account_id, slug, source, idx, start_char, len_char, doc_hash, model, dim, embedding) \
     select m.account_id, m.slug, x.source, x.idx, x.start_char, x.len_char, $4, $5, $6, x.embedding::vector \
     from agent_memory m, unnest($7::text[], $8::int[], $9::int[], $10::int[], $11::text[]) \
       as x(source, idx, start_char, len_char, embedding) \
     where m.account_id = $2::uuid and m.slug = $3 and m.flagged_at is null and ",
    doc_hash!(),
    " = $4"
);

const PURGE_SQL: &str = "delete from agent_memory_chunk c using agent_memory m \
     where m.account_id = c.account_id and m.slug = c.slug and (m.flagged_at is not null or m.slug = 'core')";

struct Doc {
    account_id: String,
    slug: String,
    description: Option<String>,
    value: String,
    hash: String,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Filled {
    pub docs: usize,
    pub chunks: usize,
    /// 서비스가 그 글을 거절한 기억 수 — 이 프로세스는 본문이 바뀔 때까지 다시 묻지 않는다.
    pub refused: usize,
    /// 서비스가 안 닿아 멈췄나.
    pub stopped: bool,
}

/// 조각 표가 있나 — 확장을 못 켠 배포에는 없다.
pub async fn table_exists(pool: &PgPool) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("select to_regclass('agent_memory_chunk') is not null")
        .fetch_one(pool)
        .await
}

/// 낡은 기억을 한 번 훑어 채운다. `failed` 는 거절된 글의 해시(프로세스 안).
pub async fn fill(
    pool: &PgPool,
    embedder: &Embedder,
    failed: &mut HashSet<String>,
) -> Result<Filled, sqlx::Error> {
    sqlx::query(PURGE_SQL).execute(pool).await?;
    if failed.len() >= FAILED_MAX {
        failed.clear();
    }
    let cfg = embedder.config();
    let dim = cfg.dim as i32;
    let skip: Vec<String> = failed.iter().cloned().collect();
    let rows: Vec<(String, String, Option<String>, String, String)> = sqlx::query_as(STALE_SQL)
        .bind(CHUNK_VERSION)
        .bind(&cfg.model)
        .bind(dim)
        .bind(&skip)
        .bind(DOCS_PER_TICK)
        .fetch_all(pool)
        .await?;
    let mut out = Filled::default();
    for (account_id, slug, description, value, hash) in rows {
        let doc = Doc {
            account_id,
            slug,
            description,
            value,
            hash,
        };
        let parts = chunks(&doc.slug, doc.description.as_deref(), &doc.value);
        match embed_all(embedder, &parts).await {
            Ok(vectors) => {
                if store(pool, &cfg.model, dim, &doc, &parts, &vectors).await? {
                    out.docs += 1;
                    out.chunks += parts.len();
                }
            }
            // 그 글의 문제 — 이 글만 건너뛴다(앞줄을 막지 않게).
            Err(EmbedError::BadInput | EmbedError::BadResponse | EmbedError::Status(400..=499)) => {
                failed.insert(doc.hash);
                out.refused += 1;
            }
            // 서비스의 문제 — 다음 tick 에 다시.
            Err(EmbedError::Timeout | EmbedError::Transport | EmbedError::Status(_)) => {
                out.stopped = true;
                break;
            }
        }
    }
    Ok(out)
}

async fn embed_all(embedder: &Embedder, parts: &[Chunk]) -> Result<Vec<Vec<f32>>, EmbedError> {
    let mut out = Vec::with_capacity(parts.len());
    for group in parts.chunks(BATCH_SIZE) {
        let texts: Vec<&str> = group.iter().map(|c| c.text.as_str()).collect();
        out.extend(embedder.batch(&texts).await?);
    }
    Ok(out)
}

/// 옛 조각을 새 조각으로 바꾼다. 그 사이 기억이 바뀌었거나 없어졌으면 되돌리고 `false`.
async fn store(
    pool: &PgPool,
    model: &str,
    dim: i32,
    doc: &Doc,
    parts: &[Chunk],
    vectors: &[Vec<f32>],
) -> Result<bool, sqlx::Error> {
    let sources: Vec<String> = parts.iter().map(|c| c.source.to_owned()).collect();
    let idx: Vec<i32> = parts.iter().map(|c| c.idx).collect();
    let start: Vec<i32> = parts.iter().map(|c| c.start).collect();
    let len: Vec<i32> = parts.iter().map(|c| c.len).collect();
    let vectors: Vec<String> = vectors.iter().map(|v| literal(v)).collect();
    let mut tx = pool.begin().await?;
    sqlx::query("delete from agent_memory_chunk where account_id = $1::uuid and slug = $2")
        .bind(&doc.account_id)
        .bind(&doc.slug)
        .execute(&mut *tx)
        .await?;
    let n = sqlx::query(INSERT_SQL)
        .bind(CHUNK_VERSION)
        .bind(&doc.account_id)
        .bind(&doc.slug)
        .bind(&doc.hash)
        .bind(model)
        .bind(dim)
        .bind(&sources)
        .bind(&idx)
        .bind(&start)
        .bind(&len)
        .bind(&vectors)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n as usize != parts.len() {
        tx.rollback().await?;
        return Ok(false);
    }
    tx.commit().await?;
    Ok(true)
}

/// pgvector 글 꼴 `[1,2,3]`.
fn literal(v: &[f32]) -> String {
    let nums: Vec<String> = v.iter().map(f32::to_string).collect();
    format!("[{}]", nums.join(","))
}

/// 루프를 띄운다 — 30초마다, 서비스가 준비됐을 때만. `gate` 는 문지기(잠금) 연결 전용 풀, `pool` 은 sweep 풀이다.
pub fn spawn(gate: PgPool, pool: PgPool, embedder: Arc<Embedder>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(MEMORY_EMBED_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let failed = Arc::new(tokio::sync::Mutex::new(HashSet::new()));
        loop {
            every.tick().await;
            if !embedder.is_ready() {
                continue;
            }
            let (p, e, f) = (&pool, &embedder, &failed);
            match run_gated(&gate, "memory.embed", Side::Rust, || async move {
                let done = fill(p, e, &mut *f.lock().await).await?;
                if done != Filled::default() {
                    eprintln!(
                        "loop memory.embed: filled {} memories ({} chunks), refused {}, stopped {}",
                        done.docs, done.chunks, done.refused, done.stopped
                    );
                }
                Ok::<_, sqlx::Error>(())
            })
            .await
            {
                GateResult::Gate(e) => eprintln!("loop memory.embed: gate failed: {e}"),
                GateResult::Sweep(e) => eprintln!("loop memory.embed: sweep failed: {e}"),
                _ => {}
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vector_literal_shape() {
        assert_eq!(literal(&[0.5, -1.0, 0.0]), "[0.5,-1,0]");
        assert!(!literal(&[1e-20]).contains(' '));
    }

    #[test]
    fn both_statements_share_the_hash_and_the_loop_is_registered() {
        assert!(STALE_SQL.contains(doc_hash!()) && INSERT_SQL.contains(doc_hash!()));
        assert!(super::super::LOOP_NAMES.contains(&"memory.embed"));
    }
}
