//! 스키마 판 대조. 마이그레이션의 주인은 아직 TS 서버다 — Rust 는 적용하지 않고, 자기가 아는 마이그레이션이 DB 에 전부
//! 적용됐는지만 본다. 빠진 것이 있으면 기동을 거부한다(DB 가 이 바이너리보다 옛 판이다).
include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

/// 대조 결과.
#[derive(Debug, PartialEq, Eq)]
pub struct SchemaCheck {
    /// 이 바이너리는 아는데 DB 에 적용되지 않은 것 — 하나라도 있으면 기동하지 않는다.
    pub missing: Vec<String>,
    /// DB 에는 있는데 이 바이너리가 모르는 것 — TS 서버가 더 새 판이다. 앞단은 스키마를 읽지 않으므로 경고만 한다.
    pub unknown: Vec<String>,
}

pub fn compare(known: &[&str], applied: &[String]) -> SchemaCheck {
    let missing = known
        .iter()
        .filter(|k| !applied.iter().any(|a| a == *k))
        .map(|k| k.to_string())
        .collect();
    let unknown = applied
        .iter()
        .filter(|a| !known.contains(&a.as_str()))
        .cloned()
        .collect();
    SchemaCheck { missing, unknown }
}

pub async fn applied_migrations(pool: &sqlx::PgPool) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar("select name from schema_migrations order by name")
        .fetch_all(pool)
        .await
}
