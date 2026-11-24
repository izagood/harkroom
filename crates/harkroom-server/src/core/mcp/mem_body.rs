//! C4b B1b — Rust 가 답하는 **본문을 바꾸는 기억 쓰기**: `memory.set` · `memory.merge` · `memory.restore`.
//! TS `mcpPlugin.ts` 의 같은 이름 도구 + `services/memory.ts::setMemory`·`memoryCurate.ts::{mergeMemory, restoreMemory,
//! memoryWarnings}` 의 문장을 따른다. 약속은 B1a([`super::mem_writes`])와 같다:
//! - 인자는 zod 가 그대로 받는 모양만 받는다. 모양이 다르면 `None` — TS 가 검증 오류를 낸다.
//! - 쓰기 **전** 판정·DB 오류는 `None`(TS 가 처음부터 돈다). 쓰기를 시작한 뒤의 오류는 고정 문장의 `internal`(security W1).
//! - 쓰기 검사는 TS `scanWrite` 와 같은 [`crate::core::content_scan::scan_write`]. 걸려도 저장하고 표시한다.
//! - 쓰기 출처(`writeOrigin`): 턴 id 는 `x-harkroom-turn-id`(UUID 꼴만, TS 와 같다)를 이전 판 `turn_id` 에 싣는다. 회차 id(run_id)는
//!   백그라운드 회차의 set·merge([`super::bg_write`])만 싣는다. restore 는 회차 허용 목록 밖이라 입장에서 거절된다.
//! - 쓰기 풀은 [`MEMORY_BODY_PRIVILEGES`] 가 다 있을 때만 있다(`main.rs`). 없으면 이 셋은 TS 가 답한다(B1a 다섯은 그대로).
use super::mem_writes::{SLUG_HINT, conflict as slug_conflict, internal};
use super::reads2::valid_slug;
use super::respond::text_result;
use super::tools::err;
use crate::auth::Account;
use crate::core::content_scan::{ScanHit, scan_write};
use serde_json::{Value, json};
use sqlx::PgPool;

/// 이 묶음에서 Rust 가 답하는 도구.
pub const SERVED: &[&str] = &["memory.set", "memory.merge", "memory.restore"];

/// 이 묶음이 B1a([`super::mem_writes::MEMORY_WRITE_PRIVILEGES`]) 위에 더 필요한 권한. 둘 다 있어야 풀이 선다.
pub const MEMORY_BODY_PRIVILEGES: &[(&str, &str)] = &[
    ("agent_memory", "INSERT"),
    ("agent_memory.value", "UPDATE"),
    ("agent_memory.description", "UPDATE"),
    ("agent_memory.kind", "UPDATE"),
    ("agent_memory.flagged_at", "UPDATE"),
    ("agent_memory.flag_reason", "UPDATE"),
    // 이전 판 넘침(`pruneRevisions`).
    ("agent_memory_revision", "DELETE"),
];

/// shared 상수들.
pub(crate) const MAX_ITEMS: i64 = 200;
pub(crate) const MAX_VALUE: usize = 8000;
pub(crate) const MAX_CORE: usize = 3000;
pub(crate) const MAX_DESCRIPTION: usize = 200;
/// 「언제」 문장(192).
pub(crate) const MAX_WHEN: usize = 200;
const MAX_JOURNAL: i64 = 60;
const CORE_WARN: i32 = 2600;
const ITEMS_WARN: i32 = 180;
const JOURNAL_WINDOW: i64 = 5;
/// `memory.ts` `MAX_MEMORY_REVISIONS_PER_SLUG` · `MAX_CURATED_REVISIONS_PER_SLUG`.
const MAX_REVISIONS: i64 = 5;
const MAX_CURATED_REVISIONS: i64 = 20;
/// `memoryCurate.ts::MAX_ARCHIVED_MEMORIES_PER_ACCOUNT`.
const MAX_ARCHIVED: i64 = 300;

/// `memory.ts::THREAD_NOTE_HINT`.
const THREAD_NOTE_HINT: &str = "한 스레드의 진행 상태(맡긴 일·검토 대기·PR 번호·head·다음 할 일)라면 기억이 아니라 `thread.note`(threadRootId·body)에 써라 — 그 스레드의 다음 턴에 자동으로 실린다.";
/// `memory.ts::THREAD_STATE_SLUG_REFUSAL.message`.
const THREAD_STATE_MSG: &str = "`delegation-*`·`review-*` 꼴의 새 기억은 만들지 않는다 — 한 스레드·PR 하나의 진행 상태는 그 스레드의 `thread.note` 에 쓰고, 스레드를 넘는 대장(열린 위임·검토 대기)은 `thread.note.list` 로 본다. 여러 번 쓸 판정·교훈이면 분야 topic(예: `mem/<분야>/<기능>`)에 덧붙여라. 이미 있는 기억을 고치거나 보관하는 것은 된다.";

/// 쓰기 출처 — 이전 판의 `turn_id`·`run_id`.
#[derive(Clone, Copy, Default)]
pub struct Origin<'a> {
    pub turn: Option<&'a str>,
    pub run: Option<&'a str>,
}

impl<'a> From<Option<&'a str>> for Origin<'a> {
    fn from(turn: Option<&'a str>) -> Self {
        Self { turn, run: None }
    }
}

macro_rules! iso {
    ($c:literal) => {
        concat!(
            "to_char(",
            $c,
            " at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
        )
    };
}

pub(crate) fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// 칸 차례를 지키는 JSON 객체 — TS `JSON.stringify` 는 넣은 차례로 쓰는데 serde_json 의 Map 은 키를 정렬한다.
#[derive(Default)]
struct Obj(Vec<(&'static str, String)>);

impl Obj {
    fn v(mut self, k: &'static str, v: impl Into<Value>) -> Self {
        self.0.push((k, v.into().to_string()));
        self
    }
    fn raw(mut self, k: &'static str, v: String) -> Self {
        self.0.push((k, v));
        self
    }
    fn push_v(&mut self, k: &'static str, v: impl Into<Value>) {
        self.0.push((k, v.into().to_string()));
    }
    fn push_raw(&mut self, k: &'static str, v: String) {
        self.0.push((k, v));
    }
    fn text(&self) -> String {
        let body: Vec<String> = self
            .0
            .iter()
            .map(|(k, v)| format!("{}:{v}", Value::from(*k)))
            .collect();
        format!("{{{}}}", body.join(","))
    }
}

fn ok_obj(o: &Obj) -> String {
    text_result(&o.text())
}

fn err_obj(e: &Obj) -> String {
    text_result(&format!("{{\"error\":{}}}", e.text()))
}

/// `z.string().max(n).optional()` — 없음 `Some(None)`, 맞음 `Some(Some(s))`, 틀림 `None`.
#[allow(clippy::option_option)]
fn opt_str<'a>(args: &'a Value, key: &str, max: usize) -> Option<Option<&'a str>> {
    match args.get(key) {
        None => Some(None),
        Some(Value::String(s)) if js_len(s) <= max => Some(Some(s.as_str())),
        Some(_) => None,
    }
}

/// `kind: z.enum(MEMORY_KINDS).optional()`.
#[allow(clippy::option_option)]
fn kind_arg(args: &Value) -> Option<Option<&str>> {
    match args.get("kind") {
        None => Some(None),
        Some(Value::String(k)) if matches!(k.as_str(), "topic" | "procedure" | "journal") => {
            Some(Some(k.as_str()))
        }
        Some(_) => None,
    }
}

/// `memory.ts::kindRefusal`.
fn kind_refusal(kind: Option<&str>) -> Option<String> {
    match kind {
        Some("journal") => Some(err(
            "journal_retired",
            &format!(
                "journal 은 더 이상 새로 쓰지 않는다(있던 journal 은 그대로 읽힌다). {THREAD_NOTE_HINT} 여러 스레드에서 되풀이할 교훈이면 kind: \"topic\", 절차면 kind: \"procedure\" 로 다시 써라."
            ),
        )),
        None => Some(err(
            "kind_required",
            &format!(
                "`mem/*` 를 쓸 때는 kind 를 준다 — \"topic\"(여러 스레드에서 되풀이할 사실·교훈) 또는 \"procedure\"(따라 할 절차). 있던 기억을 고칠 때도 준다(memory.get 으로 지금 값을 읽었다면 같은 종류로). {THREAD_NOTE_HINT}"
            ),
        )),
        Some(_) => None,
    }
}

/// shared `looksLikeThreadState`.
fn looks_like_thread_state(slug: &str, description: Option<&str>) -> bool {
    static NAME: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static NUM: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static WORD: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let name =
        NAME.get_or_init(|| regex::Regex::new(r"^mem/(.*/)?(delegation|review)-").expect("re"));
    if name.is_match(slug) {
        return true;
    }
    let d = description.unwrap_or("");
    let num = NUM.get_or_init(|| regex::Regex::new(r"#[0-9]+").expect("re"));
    let word = WORD
        .get_or_init(|| regex::Regex::new(r"(?i)(머지|대기|초록|검토|rebase|head)").expect("re"));
    num.is_match(d) && (has_ci_word(d) || word.is_match(d))
}

/// `/(^|[^A-Za-z])CI(?![A-Za-z])/` — regex 크레이트에 뒤보기가 없어 손으로 본다.
fn has_ci_word(d: &str) -> bool {
    let b = d.as_bytes();
    let mut i = 0;
    while let Some(off) = d[i..].find("CI") {
        let at = i + off;
        let before_ok = at == 0 || !b[at - 1].is_ascii_alphabetic();
        let after_ok = b.get(at + 2).is_none_or(|c| !c.is_ascii_alphabetic());
        if before_ok && after_ok {
            return true;
        }
        i = at + 1;
    }
    false
}

/// `memory.ts::coreSections` — 절(# 제목) 단위 길이(UTF-16), 긴 것부터 5개.
fn core_sections(value: &str) -> String {
    static H: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let h = H.get_or_init(|| regex::Regex::new(r"^#{1,6}\s+(.+?)\s*$").expect("re"));
    let mut out: Vec<(String, usize)> = vec![];
    let mut heading = "(머리)".to_owned();
    let mut chars = 0usize;
    for line in value.split('\n') {
        if let Some(m) = h.captures(line) {
            if chars > 0 {
                out.push((heading.clone(), chars));
            }
            let u: Vec<u16> = m[1].encode_utf16().take(60).collect();
            heading = String::from_utf16_lossy(&u);
            chars = js_len(line) + 1;
        } else {
            chars += js_len(line) + 1;
        }
    }
    if chars > 0 {
        out.push((heading, chars));
    }
    // JS sort 는 안정 정렬이다 — Rust sort_by_key 도.
    out.sort_by_key(|o| std::cmp::Reverse(o.1));
    let items: Vec<String> = out
        .into_iter()
        .take(5)
        .map(|(heading, chars)| {
            Obj::default()
                .v("heading", heading)
                .v("chars", chars)
                .text()
        })
        .collect();
    format!("[{}]", items.join(","))
}

/// TS `localeCompare` 의 근사 — slug 글자([a-z0-9_/-])만 나오므로 ICU 뿌리 순서(`_` < `-` < `/` < 숫자 < 글자)로 맞춘다.
pub(super) fn slug_locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let key = |c: u8| -> u16 {
        match c {
            b'_' => 0,
            b'-' => 1,
            b'/' => 2,
            _ => 10 + u16::from(c),
        }
    };
    a.bytes().map(key).cmp(b.bytes().map(key))
}

/// `memoryCurate.ts::memoryWarnings`.
async fn memory_warnings(c: &PgPool, me: &Account) -> Result<Vec<String>, sqlx::Error> {
    let (core_len, active): (i32, i32) = sqlx::query_as(
        "select \
           coalesce((select char_length(value) from agent_memory where account_id = $1::uuid and slug = 'core'), 0)::int, \
           (select count(*) from agent_memory where account_id = $1::uuid and archived_at is null)::int",
    )
    .bind(&me.id)
    .fetch_one(c)
    .await?;
    let mut out = vec![];
    if core_len >= CORE_WARN {
        out.push(
            Obj::default()
                .v("code", "core_near_limit")
                .v("length", core_len)
                .v("limit", MAX_CORE)
                .text(),
        );
    }
    if active >= ITEMS_WARN {
        out.push(
            Obj::default()
                .v("code", "items_near_limit")
                .v("active", active)
                .v("limit", MAX_ITEMS)
                .text(),
        );
    }
    // updatedAt 은 JS Date(ms) 로 비교된다 — ms 로 자른 값으로 받는다.
    let journals: Vec<(String, i64)> = sqlx::query_as(
        "select slug, (extract(epoch from date_trunc('milliseconds', updated_at)) * 1000)::bigint from agent_memory \
         where account_id = $1::uuid and kind = 'journal' and archived_at is null",
    )
    .bind(&me.id)
    .fetch_all(c)
    .await?;
    let n = journals.len() as i64;
    if n > MAX_JOURNAL - JOURNAL_WINDOW {
        let keep = (MAX_JOURNAL - JOURNAL_WINDOW) as usize;
        let mut j = journals;
        j.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| slug_locale_cmp(&a.0, &b.0)));
        let mut expiring: Vec<String> = j.into_iter().skip(keep).map(|x| x.0).collect();
        expiring.reverse();
        out.push(
            Obj::default()
                .v("code", "journal_expiring")
                .v("count", n)
                .v("limit", MAX_JOURNAL)
                .v("expiring", expiring)
                .text(),
        );
    }
    Ok(out)
}

/// `pruneRevisions` — 보통 판 5, 이유 붙은 판 20.
async fn prune_revisions<'e, E: sqlx::PgExecutor<'e>>(
    c: E,
    me: &Account,
    slug: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "delete from agent_memory_revision \
         where account_id = $1::uuid and slug = $2 and id not in ( \
           (select id from agent_memory_revision where account_id = $1::uuid and slug = $2 and reason is null \
            order by replaced_at desc, id desc limit $3) \
           union \
           (select id from agent_memory_revision where account_id = $1::uuid and slug = $2 and reason is not null \
            order by replaced_at desc, id desc limit $4))",
    )
    .bind(&me.id)
    .bind(slug)
    .bind(MAX_REVISIONS)
    .bind(MAX_CURATED_REVISIONS)
    .execute(c)
    .await?;
    Ok(())
}

/// `pruneArchived`(B1a archive 와 같은 문장).
async fn prune_archived(c: &mut sqlx::PgConnection, me: &Account) -> Result<(), sqlx::Error> {
    sqlx::query(
        "with d as ( \
           delete from agent_memory where account_id = $1::uuid and archived_at is not null and slug in ( \
             select slug from agent_memory where account_id = $1::uuid and archived_at is not null \
             order by archived_at desc, slug offset $2) \
           returning slug, value, description, updated_at, flagged_at, kind) \
         insert into agent_memory_revision (account_id, slug, value, description, updated_at, flagged, kind) \
         select $1::uuid, slug, value, description, updated_at, flagged_at is not null, kind from d",
    )
    .bind(&me.id)
    .bind(MAX_ARCHIVED)
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// mcpPlugin `threadStateSlugRefusal`.
async fn thread_state_refusal(
    read: &PgPool,
    me: &Account,
    slug: &str,
) -> Result<Option<String>, sqlx::Error> {
    if !crate::core::mem_search::is_thread_state_slug(slug) {
        return Ok(None);
    }
    let row: Option<(bool,)> = sqlx::query_as(
        "select archived_at is not null from agent_memory where account_id = $1::uuid and slug = $2",
    )
    .bind(&me.id)
    .bind(slug)
    .fetch_optional(read)
    .await?;
    Ok(match row {
        None => Some(err("thread_state_slug", THREAD_STATE_MSG)),
        Some((true,)) => Some(err(
            "thread_state_slug",
            &format!(
                "{slug} 은 보관된 상태 꼴 기억이다 — 쓰기로 되살리지 않는다. 정말 다시 쓸 것이면 memory.unarchive 로 되살린 뒤 고쳐라. {THREAD_STATE_MSG}"
            ),
        )),
        Some((false,)) => None,
    })
}

/// mcpPlugin `readMemoryDescription`.
async fn read_description(
    c: &PgPool,
    me: &Account,
    slug: &str,
) -> Result<Option<String>, sqlx::Error> {
    let r: Option<(Option<String>,)> = sqlx::query_as(
        "select description from agent_memory where account_id = $1::uuid and slug = $2",
    )
    .bind(&me.id)
    .bind(slug)
    .fetch_optional(c)
    .await?;
    Ok(r.and_then(|x| x.0))
}

/// 쓰기 역할이 `when_hint` 를 고칠 수 있나(192 의 GRANT).
async fn can_write_when(write: &PgPool) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "select has_column_privilege(current_user, 'agent_memory', 'when_hint', 'UPDATE')",
    )
    .fetch_one(write)
    .await
}

/// 지금 저장된 `(「언제」, 요약)`.
async fn read_kept(
    c: impl sqlx::PgExecutor<'_>,
    me: &Account,
    slug: &str,
) -> Result<(Option<String>, Option<String>), sqlx::Error> {
    let r: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "select when_hint, description from agent_memory where account_id = $1::uuid and slug = $2",
    )
    .bind(&me.id)
    .bind(slug)
    .fetch_optional(c)
    .await?;
    Ok(r.unwrap_or_default())
}

/// 쓰기 트랜잭션 안에서, 방금 쓴 행에 **남은** 칸(「언제」, 그리고 `description` 을 안 준 쓰기면 요약)까지 넣어 다시
/// 검사한다. 걸리면 표시한다.
///
/// 안 준 칸은 있던 글자가 남는다 — `set` 밖의 길(merge·restore·사람의 고침)은 「언제」를 건드리지 않아 있던 글자가 남는다. 그 글자를 빼고 검사하면
/// 걸려 있던 문장이 본문만 바꿔도 풀린다. 행은 앞 쓰기가 잠갔으니 그 사이 다른 턴이 바꿀 수 없다.
async fn flag_kept(
    c: &mut sqlx::PgConnection,
    me: &Account,
    slug: &str,
    parts: &[Option<&str>],
    description_kept: bool,
) -> Result<Option<ScanHit>, sqlx::Error> {
    let (when, description) = read_kept(&mut *c, me, slug).await?;
    let description = description.filter(|_| description_kept);
    if when.is_none() && description.is_none() {
        return Ok(None);
    }
    let mut all = parts.to_vec();
    all.extend([description.as_deref(), when.as_deref()]);
    let hit = scan_write(&all);
    if let Some(h) = &hit {
        sqlx::query(
            "update agent_memory set flagged_at = now(), flag_reason = $3 \
             where account_id = $1::uuid and slug = $2 and flagged_at is null",
        )
        .bind(&me.id)
        .bind(slug)
        .bind(&h.reason)
        .execute(&mut *c)
        .await?;
    }
    Ok(hit)
}

/// `datetime({offset:true})` 부분집합 + Postgres 가 읽는지(쓰기 전, 못 읽으면 TS 로).
async fn date_ok(pool: &PgPool, s: &str) -> Option<()> {
    if !super::mem_writes::datetime_ok(s) {
        return None;
    }
    sqlx::query("select $1::timestamptz")
        .bind(s)
        .execute(pool)
        .await
        .ok()?;
    Some(())
}

/// 쓴 뒤의 답 꼬리(warnings·threadState·flagged) — 쓰기 뒤라 오류는 `internal`.
fn flagged_fields(out: &mut Obj, hit: &ScanHit, notice: String) {
    out.push_raw(
        "flagged",
        Obj::default()
            .v("reason", hit.reason.as_str())
            .v("rules", hit.rules.clone())
            .text(),
    );
    out.push_v("notice", notice);
}

fn warnings_text(w: &[String]) -> String {
    format!("[{}]", w.join(","))
}

pub async fn answer(
    read: &PgPool,
    write: Option<&PgPool>,
    me: &Account,
    turn: Origin<'_>,
    tool: &str,
    args: &Value,
) -> Option<Option<String>> {
    if !SERVED.contains(&tool) {
        return None;
    }
    let Some(write) = write else {
        return Some(None);
    };
    Some(match tool {
        "memory.set" => set(read, write, me, turn, args).await,
        "memory.merge" => merge(read, write, me, turn, args).await,
        "memory.restore" => restore(write, me, turn, args).await,
        _ => None,
    })
}

/// `memory.set`.
async fn set(
    read: &PgPool,
    write: &PgPool,
    me: &Account,
    turn: Origin<'_>,
    args: &Value,
) -> Option<String> {
    let slug = args.get("slug")?.as_str().filter(|s| !s.is_empty())?;
    let value: Option<&str> = match args.get("value")? {
        Value::Null => None,
        Value::String(v) if js_len(v) <= MAX_VALUE => Some(v.as_str()),
        _ => return None,
    };
    let description = opt_str(args, "description", MAX_DESCRIPTION)?;
    let when = opt_str(args, "when", MAX_WHEN)?;
    let kind = kind_arg(args)?;
    let expect = super::mem_writes::if_updated_at(args)?;
    if let Some(Some(at)) = expect {
        date_ok(write, at).await?;
    }
    if !valid_slug(slug) {
        return Some(err("invalid_slug", SLUG_HINT));
    }
    if let Some(v) = value.filter(|_| slug == "core") {
        let n = js_len(v);
        if n > MAX_CORE {
            return Some(err_obj(&Obj::default()
                .v("code", "core_too_long")
                .v("message", format!("core 는 {MAX_CORE}자까지다(지금 {n}자). core 는 매 턴 통째로 실린다 — 한 가지 주제로 묶이는 것은 `mem/<이름>` 으로 옮기고 core 에는 포인터 한 줄만 남겨라. sections 는 절(## 제목) 단위 길이, 긴 것부터 — 내릴 후보다."))
                .raw("sections", core_sections(v))));
        }
    }
    if slug != "core" && value.is_some() {
        if let Some(r) = kind_refusal(kind) {
            return Some(r);
        }
        if let Some(r) = thread_state_refusal(read, me, slug).await.ok()? {
            return Some(r);
        }
    }
    // 쓰기 **전에** 칸 권한을 본다 — 본문만 저장되고 「언제」는 거절되는 반쪽 쓰기를 막는다.
    if when.is_some() && value.is_some() && !can_write_when(write).await.ok()? {
        return Some(err(
            "when_unavailable",
            "이 서버는 아직 `when` 칸을 쓸 수 없다(권한 없음) — when 을 빼고 다시 써라. 아무것도 저장하지 않았다.",
        ));
    }
    // 안 준 「언제」·요약은 있던 것이 남는다 — 남는 글자까지 검사해야 걸린 문장이 본문만 고쳐 풀리지 않는다.
    let (kept_when, kept_description) = if value.is_some() {
        read_kept(read, me, slug).await.ok()?
    } else {
        (None, None)
    };
    let flag = value.and_then(|v| {
        scan_write(&[
            Some(v),
            description.or(kept_description.as_deref()),
            when.or(kept_when.as_deref()),
        ])
    });
    // 여기부터 쓰기다(W1).
    let r = match value {
        None => delete(write, me, turn, slug, expect).await,
        Some(v) => {
            upsert(
                write,
                me,
                turn,
                slug,
                v,
                description,
                kind,
                expect,
                flag.as_ref(),
                when,
            )
            .await
        }
    };
    let r = match r {
        Ok(r) => r,
        Err(_) => return Some(internal()),
    };
    match r {
        SetOutcome::Conflict(now) => {
            let message = match &now {
                Some(at) => format!(
                    "그 사이 다른 턴이 이 기억을 고쳤다(지금 판 {at}). memory.get 으로 지금 값을 읽고, 네 변경을 합쳐 그 updatedAt 으로 다시 써라 — 덮어쓰면 그 턴이 적은 것이 사라진다."
                ),
                None => "그 사이 이 기억이 지워졌다. 되살릴 것인지 먼저 판단하고, 되살린다면 ifUpdatedAt: null 로 써라.".to_owned(),
            };
            return Some(err_obj(
                &Obj::default()
                    .v("code", "conflict")
                    .v("message", message)
                    .v("updatedAt", now),
            ));
        }
        SetOutcome::TooMany => {
            return Some(err(
                "too_many",
                &format!("at most {MAX_ITEMS} memories per account"),
            ));
        }
        SetOutcome::Ok => {}
    }
    let tail: Result<String, sqlx::Error> = async {
        let warnings = memory_warnings(write, me).await?;
        let state_like = if value.is_some() && slug != "core" {
            let d = match description {
                Some(d) => Some(d.to_owned()),
                None => read_description(write, me, slug).await?,
            };
            looks_like_thread_state(slug, d.as_deref())
        } else {
            false
        };
        let mut out = Obj::default().v("ok", true);
        if !warnings.is_empty() {
            out.push_raw("warnings", warnings_text(&warnings));
        }
        if state_like {
            out.push_v(
                "threadState",
                format!(
                    "이 기억은 한 스레드의 진행 상태로 보인다. {THREAD_NOTE_HINT} 여기에는 여러 스레드에서 되풀이할 교훈만 남겨라."
                ),
            );
        }
        if let Some(hit) = &flag {
            flagged_fields(&mut out, hit, format!(
                "저장했지만 쓰기 검사에 걸렸다({}). 사람이 확인할 때까지 이 판은 목록 요약·recall·memory.get 어디에도 실리지 않는다. 남의 글을 옮겨 적었거나 비밀 값을 넣었다면 빼고 다시 써라. 그대로 둬야 하면 사람에게 확인을 부탁해라(설정 › 에이전트 › 기억).",
                hit.reason
            ));
        }
        Ok(ok_obj(&out))
    }
    .await;
    Some(tail.unwrap_or_else(|_| internal()))
}

pub(crate) enum SetOutcome {
    Ok,
    TooMany,
    Conflict(Option<String>),
}

const CURRENT_SQL: &str = concat!(
    "select ",
    iso!("updated_at"),
    ", coalesce(date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $3::timestamptz), false) \
     from agent_memory where account_id = $1::uuid and slug = $2"
);

/// `currentUpdatedAt` + ms 비교.
async fn current(
    c: &PgPool,
    me: &Account,
    slug: &str,
    at: Option<&str>,
) -> Result<Option<(String, bool)>, sqlx::Error> {
    sqlx::query_as(CURRENT_SQL)
        .bind(&me.id)
        .bind(slug)
        .bind(at)
        .fetch_optional(c)
        .await
}

/// `setMemory(value = null)`.
#[allow(clippy::option_option)]
pub(crate) async fn delete(
    write: &PgPool,
    me: &Account,
    turn: Origin<'_>,
    slug: &str,
    expect: Option<Option<&str>>,
) -> Result<SetOutcome, sqlx::Error> {
    match expect {
        Some(None) => {
            let now = current(write, me, slug, None).await?;
            Ok(now.map_or(SetOutcome::Ok, |(at, _)| SetOutcome::Conflict(Some(at))))
        }
        Some(Some(at)) => {
            let n = sqlx::query(
                "with d as ( \
                   delete from agent_memory where account_id = $1::uuid and slug = $2 \
                     and date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $3::timestamptz) \
                   returning slug, value, description, updated_at, flagged_at, kind) \
                 insert into agent_memory_revision (account_id, slug, value, description, updated_at, flagged, kind, run_id, turn_id) \
                 select $1::uuid, slug, value, description, updated_at, flagged_at is not null, kind, $5::uuid, $4::uuid from d",
            )
            .bind(&me.id)
            .bind(slug)
            .bind(at)
            .bind(turn.turn)
.bind(turn.run)
            .execute(write)
            .await?
            .rows_affected();
            if n > 0 {
                prune_revisions(write, me, slug).await?;
                return Ok(SetOutcome::Ok);
            }
            let now = current(write, me, slug, None).await?;
            Ok(now.map_or(SetOutcome::Ok, |(at, _)| SetOutcome::Conflict(Some(at))))
        }
        None => {
            sqlx::query(
                "with d as ( \
                   delete from agent_memory where account_id = $1::uuid and slug = $2 \
                   returning slug, value, description, updated_at, flagged_at, kind) \
                 insert into agent_memory_revision (account_id, slug, value, description, updated_at, flagged, kind, run_id, turn_id) \
                 select $1::uuid, slug, value, description, updated_at, flagged_at is not null, kind, $4::uuid, $3::uuid from d",
            )
            .bind(&me.id)
            .bind(slug)
            .bind(turn.turn)
.bind(turn.run)
            .execute(write)
            .await?;
            prune_revisions(write, me, slug).await?;
            Ok(SetOutcome::Ok)
        }
    }
}

/// `setMemory(value = 문자열)` — TS 와 같은 한 문장(상한·판 비교·이전 판).
#[allow(clippy::too_many_arguments, clippy::option_option)]
pub(crate) async fn upsert(
    write: &PgPool,
    me: &Account,
    turn: Origin<'_>,
    slug: &str,
    value: &str,
    description: Option<&str>,
    kind: Option<&str>,
    expect: Option<Option<&str>>,
    flag: Option<&ScanHit>,
    when: Option<&str>,
) -> Result<SetOutcome, sqlx::Error> {
    let mut tx = write.begin().await?;
    let mode = match expect {
        None => "none",
        Some(None) => "absent",
        Some(Some(_)) => "at",
    };
    let n: i32 = sqlx::query_scalar(
        "with prev as ( \
           select slug, value, description, updated_at, flagged_at, archived_at, kind from agent_memory where account_id = $1::uuid and slug = $2), \
         ins as ( \
           insert into agent_memory (account_id, slug, value, description, kind, flagged_at, flag_reason) \
           select $1::uuid, $2, $3, nullif($5, ''), coalesce($7, 'topic'), case when $10::text is null then null else now() end, $10::text \
           where ((select count(*) from agent_memory where account_id = $1::uuid and archived_at is null) < $4 \
              or exists (select 1 from prev where archived_at is null)) \
             and ($8 = 'none' or ($8 = 'absent' and not exists (select 1 from prev)) or ($8 = 'at' and exists (select 1 from prev))) \
           on conflict (account_id, slug) do update set \
             value = excluded.value, \
             description = case when $6 then excluded.description else agent_memory.description end, \
             kind = coalesce($7, agent_memory.kind), \
             flagged_at = excluded.flagged_at, \
             flag_reason = excluded.flag_reason, \
             archived_at = null, \
             updated_at = now() \
           where $8 = 'none' \
              or ($8 = 'at' and date_trunc('milliseconds', agent_memory.updated_at) = date_trunc('milliseconds', $9::timestamptz)) \
           returning 1), \
         rev as ( \
           insert into agent_memory_revision (account_id, slug, value, description, updated_at, flagged, kind, run_id, turn_id) \
           select $1::uuid, slug, value, description, updated_at, flagged_at is not null, kind, $12::uuid, $11::uuid from prev where exists (select 1 from ins) \
           returning 1) \
         select (select count(*) from ins)::int",
    )
    .bind(&me.id)
    .bind(slug)
    .bind(value)
    .bind(MAX_ITEMS)
    .bind(description)
    .bind(description.is_some())
    .bind(kind)
    .bind(mode)
    .bind(expect.flatten())
    .bind(flag.map(|f| f.reason.as_str()))
    .bind(turn.turn)
.bind(turn.run)
    .fetch_one(&mut *tx)
    .await?;
    if n == 0 {
        tx.rollback().await?;
        if let Some(e) = expect {
            let now = current(write, me, slug, e).await?;
            let matches = match (e, &now) {
                (None, None) => true,
                (Some(_), Some((_, same))) => *same,
                _ => false,
            };
            if !matches {
                return Ok(SetOutcome::Conflict(now.map(|x| x.0)));
            }
        }
        return Ok(SetOutcome::TooMany);
    }
    // 본문과 「언제」는 한 트랜잭션이다 — 새 본문에 옛 「언제」가 붙은 채 보이는 순간이 없다. 빈 글자면 지운다.
    if let Some(w) = when {
        sqlx::query(
            "update agent_memory set when_hint = nullif($3, '') where account_id = $1::uuid and slug = $2",
        )
        .bind(&me.id)
        .bind(slug)
        .bind(w)
        .execute(&mut *tx)
        .await?;
    }
    // 사람이 고친 본문은 검사하지 않지만(TS 와 같다) 화면에 없는 「언제」와 안 준 요약은 그 고침이 쓴 글자가 아니다.
    flag_kept(&mut tx, me, slug, &[], description.is_none()).await?;
    tx.commit().await?;
    prune_revisions(write, me, slug).await?;
    // `pruneJournal`.
    sqlx::query(
        "with d as ( \
           delete from agent_memory where account_id = $1::uuid and kind = 'journal' and archived_at is null and slug in ( \
             select slug from agent_memory where account_id = $1::uuid and kind = 'journal' and archived_at is null \
             order by updated_at desc, slug offset $2) \
           returning slug, value, description, updated_at, flagged_at, kind) \
         insert into agent_memory_revision (account_id, slug, value, description, updated_at, flagged, kind) \
         select $1::uuid, slug, value, description, updated_at, flagged_at is not null, kind from d",
    )
    .bind(&me.id)
    .bind(MAX_JOURNAL)
    .execute(write)
    .await?;
    Ok(SetOutcome::Ok)
}

/// JS 객체 키 차례(정수 꼴 키가 먼저, 오름차순)를 따질 수 없어 — serde_json 은 키를 정렬한다 — 어긋난 판이 둘 이상이면 TS 에 맡긴다.
/// 하나면 차례와 상관없이 같은 답이다.
type Expect = Vec<(String, Option<String>)>;

fn expect_arg(args: &Value) -> Option<Option<Expect>> {
    match args.get("ifUpdatedAt") {
        None => Some(None),
        Some(Value::Object(m)) => {
            let mut out = vec![];
            for (k, v) in m {
                match v {
                    Value::Null => out.push((k.clone(), None)),
                    Value::String(s) if super::mem_writes::datetime_ok(s) => {
                        out.push((k.clone(), Some(s.clone())))
                    }
                    _ => return None,
                }
            }
            Some(Some(out))
        }
        Some(_) => None,
    }
}

/// `memory.merge`.
async fn merge(
    read: &PgPool,
    write: &PgPool,
    me: &Account,
    turn: Origin<'_>,
    args: &Value,
) -> Option<String> {
    let into = args.get("into")?.as_str().filter(|s| !s.is_empty())?;
    let from_arr = args.get("from")?.as_array()?;
    if from_arr.is_empty() || from_arr.len() > 10 {
        return None;
    }
    let mut from_in: Vec<&str> = vec![];
    for f in from_arr {
        from_in.push(f.as_str().filter(|s| !s.is_empty())?);
    }
    let value = args
        .get("value")?
        .as_str()
        .filter(|v| (1..=MAX_VALUE).contains(&js_len(v)))?;
    let description = opt_str(args, "description", MAX_DESCRIPTION)?;
    let kind = kind_arg(args)?;
    let expect = expect_arg(args)?;
    for (_, at) in expect.iter().flatten() {
        if let Some(at) = at {
            date_ok(write, at).await?;
        }
    }
    for s in std::iter::once(into).chain(from_in.iter().copied()) {
        if !valid_slug(s) {
            return Some(err_obj(
                &Obj::default()
                    .v("code", "invalid_slug")
                    .v("slug", s)
                    .v("message", SLUG_HINT),
            ));
        }
    }
    if into == "core" || from_in.contains(&"core") {
        return Some(err(
            "core_not_mergeable",
            "core 는 합치기의 대상이 아니다 — memory.set 으로 써라",
        ));
    }
    if let Some(r) = kind_refusal(kind) {
        return Some(r);
    }
    if let Some(r) = thread_state_refusal(read, me, into).await.ok()? {
        return Some(r);
    }
    let mut from: Vec<&str> = vec![];
    for s in &from_in {
        if *s != into && !from.contains(s) {
            from.push(s);
        }
    }
    let r = merge_tx(
        write,
        me,
        turn,
        into,
        &from,
        value,
        description,
        kind,
        expect.as_deref(),
    )
    .await;
    let r = match r {
        Ok(Some(r)) => r,
        // 어긋난 판이 둘 이상 — 롤백했으니 TS 가 처음부터 돈다.
        Ok(None) => return None,
        Err(_) => return Some(internal()),
    };
    let flag = match r {
        MergeOutcome::TooMany => {
            return Some(err(
                "too_many",
                &format!("at most {MAX_ITEMS} active memories per account"),
            ));
        }
        MergeOutcome::NotFound(slugs) => {
            return Some(err_obj(
                &Obj::default().v("code", "not_found").v("slugs", slugs).v(
                    "message",
                    "from 중 없는 기억이 있다 — 아무것도 바꾸지 않았다",
                ),
            ));
        }
        MergeOutcome::Conflict(slug, at) => return Some(slug_conflict(&slug, at.as_deref())),
        MergeOutcome::Ok(flag) => flag,
    };
    let tail: Result<String, sqlx::Error> = async {
        prune_revisions(write, me, into).await?;
        let warnings = memory_warnings(write, me).await?;
        let d = match description {
            Some(d) => Some(d.to_owned()),
            None => read_description(write, me, into).await?,
        };
        let mut out = Obj::default().v("ok", true);
        out.push_v(
            "archived",
            from_in.iter().filter(|s| **s != into).map(|s| (*s).to_owned()).collect::<Vec<_>>(),
        );
        if !warnings.is_empty() {
            out.push_raw("warnings", warnings_text(&warnings));
        }
        if looks_like_thread_state(into, d.as_deref()) {
            out.push_v(
                "threadState",
                format!("합친 기억이 한 스레드의 진행 상태로 보인다. {THREAD_NOTE_HINT}"),
            );
        }
        if let Some(hit) = &flag {
            flagged_fields(&mut out, hit, "합친 본문이 쓰기 검사에 걸렸다 — 사람이 확인할 때까지 프롬프트에 안 실린다. 지시문·비밀 값 없이 다시 써라.".to_owned());
        }
        Ok(ok_obj(&out))
    }
    .await;
    Some(tail.unwrap_or_else(|_| internal()))
}

enum MergeOutcome {
    /// 쓰기 검사 결과.
    Ok(Option<ScanHit>),
    TooMany,
    NotFound(Vec<String>),
    Conflict(String, Option<String>),
}

/// 잠근 행: slug → (value, description, updated_at ISO, flagged, archived, kind, ms 비교용 epoch ms).
struct Locked {
    slug: String,
    value: String,
    description: Option<String>,
    updated_ms: i64,
    updated_iso: String,
    flagged: bool,
    archived: bool,
    kind: String,
}

async fn lock_rows(
    c: &mut sqlx::PgConnection,
    me: &Account,
    slugs: &[&str],
) -> Result<Vec<Locked>, sqlx::Error> {
    type R = (
        String,
        String,
        Option<String>,
        i64,
        String,
        bool,
        bool,
        String,
    );
    let rows: Vec<R> = sqlx::query_as(concat!(
        "select slug, value, description, (extract(epoch from date_trunc('milliseconds', updated_at)) * 1000)::bigint, ",
        iso!("updated_at"),
        ", flagged_at is not null, archived_at is not null, kind from agent_memory \
         where account_id = $1::uuid and slug = any($2::text[]) order by slug for update"
    ))
    .bind(&me.id)
    .bind(slugs)
    .fetch_all(&mut *c)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(slug, value, description, updated_ms, updated_iso, flagged, archived, kind)| Locked {
                slug,
                value,
                description,
                updated_ms,
                updated_iso,
                flagged,
                archived,
                kind,
            },
        )
        .collect())
}

async fn active_count(c: &mut sqlx::PgConnection, me: &Account) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "select count(*) from agent_memory where account_id = $1::uuid and archived_at is null",
    )
    .bind(&me.id)
    .fetch_one(&mut *c)
    .await
}

/// 시각 글자 → epoch ms(Postgres 로 읽는다 — JS `new Date()` 와 같은 ms).
async fn epoch_ms(c: &mut sqlx::PgConnection, at: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "select (extract(epoch from date_trunc('milliseconds', $1::timestamptz)) * 1000)::bigint",
    )
    .bind(at)
    .fetch_one(&mut *c)
    .await
}

/// `mergeMemory`. `Ok(None)` = 어긋난 판이 둘 이상(롤백, TS 로).
#[allow(clippy::too_many_arguments)]
async fn merge_tx(
    write: &PgPool,
    me: &Account,
    turn: Origin<'_>,
    into: &str,
    from: &[&str],
    value: &str,
    description: Option<&str>,
    kind: Option<&str>,
    expect: Option<&[(String, Option<String>)]>,
) -> Result<Option<MergeOutcome>, sqlx::Error> {
    let mut flag = scan_write(&[Some(value), description]);
    let mut tx = write.begin().await?;
    let mut all = vec![into];
    all.extend_from_slice(from);
    let rows = lock_rows(&mut tx, me, &all).await?;
    let get = |s: &str| rows.iter().find(|r| r.slug == s);
    let missing: Vec<String> = from
        .iter()
        .filter(|s| get(s).is_none())
        .map(|s| (*s).to_owned())
        .collect();
    if !missing.is_empty() {
        tx.rollback().await?;
        return Ok(Some(MergeOutcome::NotFound(missing)));
    }
    let mut bad: Vec<(String, Option<String>)> = vec![];
    for (slug, want) in expect.unwrap_or(&[]) {
        let have = get(slug);
        let same = match (have, want) {
            (None, None) => true,
            (Some(h), Some(w)) => h.updated_ms == epoch_ms(&mut tx, w).await?,
            _ => false,
        };
        if !same {
            bad.push((slug.clone(), have.map(|h| h.updated_iso.clone())));
        }
    }
    if bad.len() > 1 {
        tx.rollback().await?;
        return Ok(None);
    }
    if let Some((slug, at)) = bad.pop() {
        tx.rollback().await?;
        return Ok(Some(MergeOutcome::Conflict(slug, at)));
    }
    let prev = get(into);
    if prev.is_none_or(|p| p.archived) {
        let freed = from
            .iter()
            .filter(|s| get(s).is_some_and(|r| !r.archived))
            .count() as i64;
        if active_count(&mut tx, me).await? - freed >= MAX_ITEMS {
            tx.rollback().await?;
            return Ok(Some(MergeOutcome::TooMany));
        }
    }
    sqlx::query(
        "insert into agent_memory (account_id, slug, value, description, kind, flagged_at, flag_reason) \
         values ($1::uuid, $2, $3, nullif($4, ''), coalesce($5, 'topic'), case when $6::text is null then null else now() end, $6) \
         on conflict (account_id, slug) do update set \
           value = excluded.value, \
           description = case when $7 then excluded.description else agent_memory.description end, \
           kind = coalesce($5, agent_memory.kind), \
           flagged_at = excluded.flagged_at, flag_reason = excluded.flag_reason, \
           archived_at = null, updated_at = now()",
    )
    .bind(&me.id)
    .bind(into)
    .bind(value)
    .bind(description)
    .bind(kind)
    .bind(flag.as_ref().map(|f| f.reason.as_str()))
    .bind(description.is_some())
    .execute(&mut *tx)
    .await?;
    if let Some(h) = flag_kept(
        &mut tx,
        me,
        into,
        &[Some(value), description],
        description.is_none(),
    )
    .await?
    {
        flag = Some(h);
    }
    let detail = json!({ "from": from, "created": prev.is_none() }).to_string();
    // into 가 새 slug 면 판 시각은 지금(TS `new Date()`). 걸림은 지금 검사 결과(security F1).
    let (rv, rd, rflag, rkind, rat) = match prev {
        Some(p) => (
            p.value.as_str(),
            p.description.as_deref(),
            p.flagged,
            p.kind.as_str(),
            Some(p.updated_iso.as_str()),
        ),
        None => (
            value,
            description,
            flag.is_some(),
            kind.unwrap_or("topic"),
            None,
        ),
    };
    sqlx::query(
        "insert into agent_memory_revision (account_id, slug, value, description, updated_at, flagged, reason, detail, kind, run_id, turn_id) \
         values ($1::uuid, $2, $3, $4, coalesce($5::timestamptz, now()), $6, 'merge', $7::jsonb, $8, $10::uuid, $9::uuid)",
    )
    .bind(&me.id)
    .bind(into)
    .bind(rv)
    .bind(rd)
    .bind(rat)
    .bind(rflag)
    .bind(&detail)
    .bind(rkind)
    .bind(turn.turn)
.bind(turn.run)
    .execute(&mut *tx)
    .await?;
    if !from.is_empty() {
        sqlx::query(
            "update agent_memory set archived_at = now(), updated_at = now() \
             where account_id = $1::uuid and slug = any($2::text[]) and archived_at is null",
        )
        .bind(&me.id)
        .bind(from)
        .execute(&mut *tx)
        .await?;
        prune_archived(&mut tx, me).await?;
    }
    tx.commit().await?;
    Ok(Some(MergeOutcome::Ok(flag)))
}

/// [`restore_one`] 의 결말 — TS `restoreMemory` 의 `'ok' | 'not_found' | 'too_many'`.
pub(crate) enum Restored {
    Ok,
    NotFound,
    TooMany,
}

/// `restoreMemory`(+ `pruneRevisions`) 한 건 — MCP `memory.restore` 와 회차 되돌리기가 같이 탄다.
pub(crate) async fn restore_one(
    write: &PgPool,
    me: &Account,
    slug: &str,
    revision: Option<i64>,
    turn: Origin<'_>,
) -> Result<Restored, sqlx::Error> {
    let mut tx = write.begin().await?;
    type RevRow = (i64, String, Option<String>, bool, Option<String>);
    let rev: Option<RevRow> = sqlx::query_as(
        "select id, value, description, flagged, kind from agent_memory_revision \
         where account_id = $1::uuid and slug = $2 and ($3::bigint is null or id = $3) \
         order by replaced_at desc, id desc limit 1",
    )
    .bind(&me.id)
    .bind(slug)
    .bind(revision)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((id, value, description, flagged, kind)) = rev else {
        tx.rollback().await?;
        return Ok(Restored::NotFound);
    };
    let flag_reason = if flagged {
        Some("restored flagged revision".to_owned())
    } else {
        scan_write(&[Some(&value), description.as_deref()]).map(|h| h.reason)
    };
    let cur = lock_rows(&mut tx, me, &[slug]).await?.into_iter().next();
    if cur.as_ref().is_none_or(|c| c.archived) && active_count(&mut tx, me).await? >= MAX_ITEMS {
        tx.rollback().await?;
        return Ok(Restored::TooMany);
    }
    if let Some(c) = &cur {
        sqlx::query(
            "insert into agent_memory_revision (account_id, slug, value, description, updated_at, flagged, reason, detail, kind, run_id, turn_id) \
             select $1::uuid, slug, value, description, updated_at, flagged_at is not null, 'restore', $3::jsonb, kind, $5::uuid, $4::uuid \
             from agent_memory where account_id = $1::uuid and slug = $2",
        )
        .bind(&me.id)
        .bind(slug)
        .bind(json!({ "revisionId": id }).to_string())
        .bind(turn.turn)
.bind(turn.run)
        .execute(&mut *tx)
        .await?;
        let _ = c;
    }
    let k = kind
        .or_else(|| cur.as_ref().map(|c| c.kind.clone()))
        .unwrap_or_else(|| "topic".to_owned());
    sqlx::query(
        "insert into agent_memory (account_id, slug, value, description, kind, flagged_at, flag_reason) \
         values ($1::uuid, $2, $3, $4, $5, case when $6::text is not null then now() end, $6::text) \
         on conflict (account_id, slug) do update set \
           value = excluded.value, description = excluded.description, \
           kind = excluded.kind, \
           flagged_at = excluded.flagged_at, flag_reason = excluded.flag_reason, \
           archived_at = null, updated_at = now()",
    )
    .bind(&me.id)
    .bind(slug)
    .bind(&value)
    .bind(description.as_deref())
    .bind(&k)
    .bind(flag_reason.as_deref())
    .execute(&mut *tx)
    .await?;
    flag_kept(
        &mut tx,
        me,
        slug,
        &[Some(&value), description.as_deref()],
        false,
    )
    .await?;
    tx.commit().await?;
    prune_revisions(write, me, slug).await?;
    Ok(Restored::Ok)
}

/// `memory.restore`.
async fn restore(write: &PgPool, me: &Account, turn: Origin<'_>, args: &Value) -> Option<String> {
    let slug = args.get("slug")?.as_str().filter(|s| !s.is_empty())?;
    let revision = match args.get("revisionId") {
        None => None,
        Some(v) => Some(super::tools::js_int(v).filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)?),
    };
    if !valid_slug(slug) {
        return Some(err("invalid_slug", SLUG_HINT));
    }
    let r = restore_one(write, me, slug, revision, turn).await;
    Some(match r {
        Ok(Restored::Ok) => text_result("{\"ok\":true}"),
        Ok(Restored::NotFound) => err("not_found", "그 판이 없다 — memory.revisions 로 확인해라"),
        Ok(Restored::TooMany) => err(
            "too_many",
            &format!("at most {MAX_ITEMS} active memories per account"),
        ),
        Err(_) => internal(),
    })
}
