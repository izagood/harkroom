//! 계획판 감시(P5) — TS `services/threadPlanWatcher.ts` 의 `startThreadPlanWatcher` 를 옮긴다.
//!
//! - **이벤트로 돈다**(tick 이 없다). outbox 허브를 구독한다:
//!   - 래퍼 머지 줄(`message.created`, `kind: system`, `meta.merge.result == "merged"`) → **같은 스레드** 계획에서 그 PR 을 단
//!     단계를 done. 시스템 줄만 믿는다(사람·에이전트가 같은 꼴 meta 를 실어 단계를 끝내지 못하게).
//!   - 카드 답(`message.updated`, `meta.kind == "ask"`, `meta.ask.answeredWith` 가 null 이 아님) → 그 카드를 단 blocked 단계를
//!     active. **처음 답이 실린 갱신에서만**(TS architect R2) — 다시 막아 둔 단계가 다음 갱신에 뒤집히지 않게.
//!   - 계획이 바뀜(`thread.plan.changed`, `via != "linked"`) → [`DEBOUNCE`] 뒤 자동 진행 깨우기, 그리고 `thread_plan_link` 로
//!     부모를 찾아 부모 이벤트(`via: "linked"`)를 청중 맵으로 낸다. 1단만 간다 — 전파로 낸 이벤트는 다시 전파하지 않는다.
//!   - 위 자동 갱신·부모 전파로 **새로** 시작 가능해진 노드가 있으면 시스템 줄 하나(멘션 없음).
//! - 자동 쓰기는 [`write_system`](TS `writeThreadPlan(…, { system: true }, build)`) 한 경로다. 바꿀 것이 없으면 rev 를 올리지 않는다.
//!   그 쓰기가 내는 `thread.plan.changed` 는 이 감시를 다시 깨우지만, 그 갈래는 계획을 쓰지 않으므로 고리가 없다(TS W6).
//! - **주인**: 일감마다 문지기([`run_gated`], 이름 `thread.plan`) 아래서 돈다. 주인이 아니면 버린다(TS 가 한다). 잠금을 못 잡으면
//!   다음 차례에 다시 한다. TS 쪽은 `loopOwner(pool, 'thread.plan') === 'ts'` 일 때만 돈다.
//! - 일감은 한 태스크가 차례로 돈다 — TS 는 루트마다 직렬이었고, 여기선 루트끼리도 직렬이다.
//! - 「앞 판」 기억(`lastDerived`·`answeredCards`)은 TS 처럼 프로세스 메모리다(재시작하면 빈다, 5000 개 상한).
use super::{GateResult, Side, run_gated};
use crate::core::mcp::plan_write::{audience_map, emit_linked, write_system};
use crate::core::msg_list::{DerivedNode, derive_plan, plan_progress};
use crate::core::msg_post::PostState;
use crate::core::msg_read::channel_visible;
use crate::core::thread_plan_auto_off::post_line;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio::time::Instant;

/// TS `debounceMs` 기본값.
pub const DEBOUNCE: Duration = Duration::from_millis(300);

/// TS `lastDerived`·`answeredCards` 의 상한.
const MEMORY_CAP: usize = 5000;

/// 이 감시가 쓰는 권한 — 운영 GRANT 와 같아야 한다. 하나라도 없으면 `main.rs` 가 띄우지 않는다(TS 에 남는다).
pub const THREAD_PLAN_PRIVILEGES: &[(&str, &str)] = &[
    ("message", "SELECT"),
    ("message", "INSERT"),
    ("account", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("thread_plan", "SELECT"),
    ("thread_plan", "UPDATE"),
    ("thread_plan", "INSERT"),
    ("thread_plan_link", "SELECT"),
    ("event_outbox", "INSERT"),
    // 자동 진행 깨움 글의 위임 키·principal 도장(`thread_plan_auto::wake` → msg_post `plan_auto_stamp`). mandate_id 는 글 권한에 있다.
    ("message.principal_account_id", "UPDATE"),
    // 켤 때의 위임장이 아직 유효한가(`mandate_line_write::valid_owner_sql`, 골든 `grant_valid_mandate_owner`).
    ("mandate", "SELECT"),
    // 자동화 위임장이면 그 자동화가 살아 있는지 읽는 4칸만 — 표 단위 SELECT 는 수신 비밀 칸까지 연다(security 11-18,
    // `decide_approve::MANDATE_LINE_PRIVILEGES` 와 같은 꼴). 빠지면 위임장 있는 판의 깨우기가 권한 오류로 멈춘다(`tests/thread_plan.rs`).
    ("automation.id", "SELECT"),
    ("automation.deleted_at", "SELECT"),
    ("automation.enabled", "SELECT"),
    ("automation.approved_at", "SELECT"),
];
pub const THREAD_PLAN_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

fn str_eq_lower(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

fn steps(doc: &Value) -> &[Value] {
    doc.get("steps")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn links(step: &Value) -> &[Value] {
    step.get("links")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// 단계마다 `hit` 이면 `state`·`blockedReason: null` 로 바꾼 새 판. 바뀐 것이 없으면 `None`.
fn set_states(doc: &Value, state: &str, hit: impl Fn(&Value) -> bool) -> Option<Value> {
    let mut changed = false;
    let next: Vec<Value> = steps(doc)
        .iter()
        .map(|s| {
            if !hit(s) {
                return s.clone();
            }
            changed = true;
            let mut s = s.clone();
            if let Some(o) = s.as_object_mut() {
                o.insert("state".into(), Value::from(state));
                o.insert("blockedReason".into(), Value::Null);
            }
            s
        })
        .collect();
    if !changed {
        return None;
    }
    let mut out = doc.clone();
    out.as_object_mut()?
        .insert("steps".into(), Value::Array(next));
    Some(out)
}

/// TS `applyMergedPr` — 머지 줄 → 그 PR 을 단(아직 done 이 아닌) 단계를 done.
pub fn apply_merged_pr(doc: &Value, repo: &str, number: f64) -> Option<Value> {
    set_states(doc, "done", |s| {
        s.get("state").and_then(Value::as_str) != Some("done")
            && links(s).iter().any(|l| {
                l.get("kind").and_then(Value::as_str) == Some("pr")
                    && l.get("number").and_then(Value::as_f64) == Some(number)
                    && l.get("repo")
                        .and_then(Value::as_str)
                        .is_some_and(|r| str_eq_lower(r, repo))
            })
    })
}

/// TS `applyAnsweredCard` — 카드 답 → 그 카드를 단 blocked 단계를 active.
pub fn apply_answered_card(doc: &Value, message_id: &str) -> Option<Value> {
    set_states(doc, "active", |s| {
        s.get("state").and_then(Value::as_str) == Some("blocked")
            && links(s).iter().any(|l| {
                l.get("kind").and_then(Value::as_str) == Some("card")
                    && l.get("messageId")
                        .and_then(Value::as_str)
                        .is_some_and(|m| str_eq_lower(m, message_id))
            })
    })
}

/// TS `readyDiff` — **앞 판에도 있던** 노드 중 앞에선 ready 가 아니었고 지금 ready 인 것(after 의 순서).
/// 새로 더한 노드는 세지 않는다(방금 세운 단계로 줄이 서면 소음이다).
pub fn ready_diff(
    before: &[(String, DerivedNode)],
    after: &[(String, DerivedNode)],
) -> Vec<String> {
    after
        .iter()
        .filter(|(id, node)| {
            node.derived == "ready"
                && before
                    .iter()
                    .find(|(k, _)| k == id)
                    .is_some_and(|(_, p)| p.derived != "ready")
        })
        .map(|(id, _)| id.clone())
        .collect()
}

fn str_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// TS `dropHiddenCaused`(D1) — ready 가 된 노드가 기다리던 것(자기·소속 그룹의 dependsOn) 중 하나라도 앞 판에서 hidden 이었으면 뺀다.
/// TS 의 `new Map(…)` 처럼 같은 id 는 나중 것이 이긴다.
pub fn drop_hidden_caused(
    ids: Vec<String>,
    doc: &Value,
    before: &[(String, DerivedNode)],
) -> Vec<String> {
    let by_id = |k: &str| -> HashMap<String, &Value> {
        doc.get(k)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|v| Some((v.get("id")?.as_str()?.to_owned(), v)))
            .collect()
    };
    let groups = by_id("groups");
    let steps = by_id("steps");
    let hidden = |d: &str| before.iter().any(|(k, n)| k == d && n.derived == "hidden");
    ids.into_iter()
        .filter(|id| {
            let mut deps = str_list(groups.get(id).and_then(|g| g.get("dependsOn")));
            let step = steps.get(id);
            deps.extend(str_list(step.and_then(|s| s.get("dependsOn"))));
            // JS 참값인 groupId 만.
            if let Some(g) = step
                .and_then(|s| s.get("groupId"))
                .and_then(Value::as_str)
                .filter(|g| !g.is_empty())
                .and_then(|g| groups.get(g))
            {
                deps.extend(str_list(g.get("dependsOn")));
            }
            !deps.iter().any(|d| hidden(d))
        })
        .collect()
}

/// TS `titleOf` — 그룹 먼저, 다음 단계, 없으면 id.
pub fn title_of(doc: &Value, id: &str) -> String {
    let find = |k: &str| {
        doc.get(k)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|v| v.get("id").and_then(Value::as_str) == Some(id))
            .and_then(|v| v.get("title").and_then(Value::as_str))
            .map(str::to_owned)
    };
    find("groups")
        .or_else(|| find("steps"))
        .unwrap_or_else(|| id.to_owned())
}

/// 이벤트가 시키는 일.
#[derive(Debug, Clone, PartialEq)]
pub enum Trigger {
    /// 래퍼 머지 줄 — `(루트, 저장소, PR 번호, 줄 작성자)`.
    Merged {
        root: String,
        repo: String,
        number: f64,
        author: String,
    },
    /// 카드 답 — `(루트, 카드 글 id, 카드 작성자)`.
    Answered {
        root: String,
        card: String,
        author: String,
    },
    /// 계획이 바뀜(전파로 낸 것은 아님).
    Changed(String),
    None,
}

/// TS `onEvent` 의 갈래.
pub fn trigger_of(e: &Value) -> Trigger {
    let ty = e.get("type").and_then(Value::as_str).unwrap_or_default();
    if ty == "thread.plan.changed" {
        if e.get("via").and_then(Value::as_str) == Some("linked") {
            return Trigger::None;
        }
        return e
            .get("rootId")
            .and_then(Value::as_str)
            .map_or(Trigger::None, |r| Trigger::Changed(r.to_owned()));
    }
    if ty != "message.created" && ty != "message.updated" {
        return Trigger::None;
    }
    let Some(m) = e.get("message") else {
        return Trigger::None;
    };
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    let Some(id) = s(m, "id") else {
        return Trigger::None;
    };
    let root = s(m, "threadRootId").unwrap_or_else(|| id.clone());
    let author = s(m, "authorId").unwrap_or_default();
    let meta = m.get("meta").filter(|v| v.is_object());
    let merge = meta.and_then(|x| x.get("merge"));
    if ty == "message.created"
        && m.get("kind").and_then(Value::as_str) == Some("system")
        && merge.and_then(|x| x.get("result")).and_then(Value::as_str) == Some("merged")
        && let Some(repo) = merge.and_then(|x| x.get("repo")).and_then(Value::as_str)
        && let Some(number) = merge.and_then(|x| x.get("number")).and_then(Value::as_f64)
    {
        return Trigger::Merged {
            root,
            repo: repo.to_owned(),
            number,
            author,
        };
    }
    if ty == "message.updated"
        && meta.and_then(|x| x.get("kind")).and_then(Value::as_str) == Some("ask")
        && meta
            .and_then(|x| x.get("ask"))
            .and_then(|a| a.get("answeredWith"))
            .is_some_and(|w| !w.is_null())
    {
        return Trigger::Answered {
            root,
            card: id,
            author,
        };
    }
    Trigger::None
}

/// 넣은 차례를 기억하는 상한 있는 집합·맵(TS `Map`/`Set` 의 「가장 오래된 것부터 지우기」).
#[derive(Default)]
pub struct Bounded<V> {
    map: HashMap<String, V>,
    order: VecDeque<String>,
}

impl<V> Bounded<V> {
    /// TS `remember` — 지우고 다시 넣어 맨 뒤로 보낸다.
    pub fn put(&mut self, k: String, v: V) {
        if self.map.insert(k.clone(), v).is_some() {
            self.order.retain(|o| o != &k);
        }
        self.order.push_back(k);
        if self.map.len() > MEMORY_CAP
            && let Some(old) = self.order.pop_front()
        {
            self.map.remove(&old);
        }
    }
    pub fn get(&self, k: &str) -> Option<&V> {
        self.map.get(k)
    }
    pub fn remove(&mut self, k: &str) {
        if self.map.remove(k).is_some() {
            self.order.retain(|o| o != k);
        }
    }
}

/// TS `markAnswered` — 처음 본 카드면 `true`.
#[derive(Default)]
pub struct Answered(Bounded<()>);

impl Answered {
    pub fn mark(&mut self, card: &str) -> bool {
        let k = card.to_lowercase();
        if self.0.get(&k).is_some() {
            return false;
        }
        self.0.put(k, ());
        true
    }
}

/// TS `systemI18n` 의 글자 인자 자르기 — 200 UTF-16 단위.
fn clip_arg(s: &str) -> String {
    let mut n = 0;
    s.chars()
        .take_while(|c| {
            n += c.len_utf16();
            n <= 200
        })
        .collect()
}

/// TS `postReady` 의 줄 — `(본문, meta)`. 본문·i18n 인자에는 고정 문구와 노드 id 만 싣는다(TS architect R1) — 단계 제목은
/// 남이 쓴 글이라 `meta.planReady.titles` 에만 둔다.
pub fn ready_line(
    ids: &[String],
    rev: i64,
    doc: &Value,
) -> (String, serde_json::Map<String, Value>) {
    let list = ids.join(" · ");
    let titles: serde_json::Map<String, Value> = ids
        .iter()
        .map(|id| (id.clone(), Value::from(title_of(doc, id))))
        .collect();
    let mut meta = serde_json::Map::new();
    meta.insert(
        "planReady".into(),
        json!({ "ids": ids, "rev": rev, "titles": titles }),
    );
    meta.insert(
        "i18n".into(),
        json!({ "key": "system.plan.ready", "args": { "n": ids.len(), "ids": clip_arg(&list) } }),
    );
    (
        format!("▶ 이제 시작할 수 있는 단계 {}개: {list}", ids.len()),
        meta,
    )
}

type Derived = Vec<(String, DerivedNode)>;

/// 감시 한 벌의 상태 — TS 클로저 안의 `lastDerived`·`answeredCards`.
pub struct Watcher {
    st: PostState,
    last: Bounded<Derived>,
    answered: Answered,
}

const ROW_SQL: &str = "select channel_id::text, doc::text, rev::int8, updated_by::text from thread_plan where root_id = $1::uuid";

struct Row {
    channel: String,
    doc: Value,
    rev: i64,
    updated_by: Option<String>,
}

impl Watcher {
    pub fn new(st: PostState) -> Self {
        Self {
            st,
            last: Bounded::default(),
            answered: Answered::default(),
        }
    }

    fn pool(&self) -> &PgPool {
        &self.st.write
    }

    async fn row(&self, root: &str) -> sqlx::Result<Option<Row>> {
        let r: Option<(String, String, i64, Option<String>)> = sqlx::query_as(ROW_SQL)
            .bind(root)
            .fetch_optional(self.pool())
            .await?;
        Ok(r.map(|(channel, doc, rev, updated_by)| Row {
            channel,
            doc: serde_json::from_str(&doc).unwrap_or(Value::Null),
            rev,
            updated_by,
        }))
    }

    /// TS `audienceDerived` — 청중 맵으로 센 파생 상태.
    async fn derived(&self, doc: &Value, channel: &str) -> sqlx::Result<Derived> {
        let mut conn = self.pool().acquire().await?;
        let map = audience_map(&mut conn, doc, channel).await?;
        Ok(derive_plan(doc, &map))
    }

    /// TS `postReady` — 저자는 후보 중 그 채널을 볼 수 있는 첫 계정. 아무도 없으면 내지 않는다.
    #[allow(clippy::too_many_arguments)]
    async fn post_ready(
        &self,
        channel: &str,
        root: &str,
        rev: i64,
        doc: &Value,
        before: &[(String, DerivedNode)],
        after: &[(String, DerivedNode)],
        authors: &[Option<&str>],
    ) -> sqlx::Result<()> {
        let ids = drop_hidden_caused(ready_diff(before, after), doc, before);
        if ids.is_empty() {
            return Ok(());
        }
        let mut author = None;
        for a in authors.iter().flatten() {
            if channel_visible(self.pool(), a, channel).await? {
                author = Some(*a);
                break;
            }
        }
        let Some(author) = author else { return Ok(()) };
        let (body, meta) = ready_line(&ids, rev, doc);
        post_line(
            &self.st,
            channel,
            root,
            author,
            body,
            meta,
            "threadPlanWatcher",
        )
        .await
    }

    /// TS `autoUpdate` — 자동 갱신 한 번. 바꿀 것이 없으면 아무것도 하지 않는다.
    pub async fn auto_update(
        &mut self,
        root: &str,
        author: &str,
        build: impl FnOnce(&Value) -> Option<Value>,
    ) -> sqlx::Result<()> {
        let Some(w) = write_system(self.pool(), root, build).await? else {
            return Ok(());
        };
        let after = self.derived(&w.doc, &w.channel).await?;
        let before = self.derived(&w.before, &w.channel).await?;
        self.last.put(root.to_owned(), after.clone());
        self.post_ready(
            &w.channel,
            root,
            w.rev,
            &w.doc,
            &before,
            &after,
            &[Some(author)],
        )
        .await
    }

    /// 머지 줄.
    pub async fn on_merged(
        &mut self,
        root: &str,
        repo: &str,
        number: f64,
        author: &str,
    ) -> sqlx::Result<()> {
        self.auto_update(root, author, |doc| apply_merged_pr(doc, repo, number))
            .await
    }

    /// 카드 답 — 처음 답이 실린 갱신에서만.
    pub async fn on_answered(&mut self, root: &str, card: &str, author: &str) -> sqlx::Result<()> {
        self.auto_update(root, author, |doc| apply_answered_card(doc, card))
            .await
    }

    /// TS `answeredCards` 표시 — 큐에 넣기 **전에** 부른다(TS 도 이벤트를 받는 자리에서 표시한다).
    pub fn mark_answered(&mut self, card: &str) -> bool {
        self.answered.mark(card)
    }

    /// 계획이 바뀜(debounce 뒤) — 앞 판 기억 → 자동 진행 → 부모 전파.
    pub async fn on_changed(&mut self, root: &str) -> sqlx::Result<()> {
        let row = self.row(root).await?;
        match &row {
            Some(r) => {
                let d = self.derived(&r.doc, &r.channel).await?;
                self.last.put(root.to_owned(), d);
            }
            None => self.last.remove(root),
        }
        self.wake_auto(root).await;
        let author = row.and_then(|r| r.updated_by);
        self.propagate(root, author.as_deref()).await
    }

    /// TS `propagate` — 자식이 바뀌었다 → 부모마다 청중 맵으로 이벤트(`via: linked`), 새로 ready 가 된 것이 있으면 줄.
    async fn propagate(&mut self, child: &str, author: Option<&str>) -> sqlx::Result<()> {
        let parents: Vec<String> = sqlx::query_scalar(
            "select parent_root::text from thread_plan_link where child_root = $1::uuid",
        )
        .bind(child)
        .fetch_all(self.pool())
        .await?;
        for parent in parents {
            if let Err(e) = self.propagate_one(&parent, author).await {
                eprintln!("loop thread.plan: propagate {parent} failed: {e}");
            }
        }
        Ok(())
    }

    async fn propagate_one(&mut self, parent: &str, author: Option<&str>) -> sqlx::Result<()> {
        let Some(row) = self.row(parent).await? else {
            return Ok(());
        };
        let mut tx = self.pool().begin().await?;
        let map = audience_map(&mut tx, &row.doc, &row.channel).await?;
        let after = derive_plan(&row.doc, &map);
        emit_linked(
            &mut tx,
            &row.channel,
            parent,
            row.rev,
            &plan_progress(&row.doc, &map),
        )
        .await?;
        tx.commit().await?;
        let before = self.last.get(parent).cloned();
        self.last.put(parent.to_owned(), after.clone());
        // 저자: 자식을 쓴 계정이 부모 채널을 보면 그 계정, 아니면 부모 계획을 마지막으로 쓴 계정(TS R3).
        if let Some(before) = before {
            self.post_ready(
                &row.channel,
                parent,
                row.rev,
                &row.doc,
                &before,
                &after,
                &[author, row.updated_by.as_deref()],
            )
            .await?;
        }
        self.wake_auto(parent).await;
        Ok(())
    }

    /// TS `wakeAuto` — 자동 진행 한 번. 실패가 감시를 멈추지 않는다.
    async fn wake_auto(&self, root: &str) {
        if let Err(e) = super::thread_plan_auto::wake(&self.st, root).await {
            eprintln!("[threadPlanWatcher] auto wake failed: {root}: {e}");
        }
    }
}

/// 큐에 넣는 일감 하나.
#[derive(Debug, Clone, PartialEq)]
enum Job {
    Merged {
        root: String,
        repo: String,
        number: f64,
        author: String,
    },
    Answered {
        root: String,
        card: String,
        author: String,
    },
    Changed(String),
}

impl Watcher {
    async fn run(&mut self, job: &Job) -> sqlx::Result<()> {
        match job {
            Job::Merged {
                root,
                repo,
                number,
                author,
            } => self.on_merged(root, repo, *number, author).await,
            Job::Answered { root, card, author } => self.on_answered(root, card, author).await,
            Job::Changed(root) => self.on_changed(root).await,
        }
    }
}

/// 감시를 띄운다. `gate` 는 문지기 풀, `st` 는 시스템 줄을 올리는 글 경로(쓰기는 `st.write`).
pub fn spawn(
    gate: PgPool,
    st: PostState,
    mut events: broadcast::Receiver<Arc<Value>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut w = Watcher::new(st);
        // 바로 할 일(머지 줄·카드 답)과 debounce 할 일(계획 바뀜).
        let mut now_jobs: VecDeque<Job> = VecDeque::new();
        let mut due: HashMap<String, Instant> = HashMap::new();
        loop {
            let next = due.values().min().copied();
            if now_jobs.is_empty() {
                tokio::select! {
                    ev = events.recv() => match ev {
                        Ok(e) => match trigger_of(&e) {
                            Trigger::Merged { root, repo, number, author } => {
                                now_jobs.push_back(Job::Merged { root, repo, number, author });
                            }
                            Trigger::Answered { root, card, author } => {
                                if w.mark_answered(&card) {
                                    now_jobs.push_back(Job::Answered { root, card, author });
                                }
                            }
                            Trigger::Changed(root) => {
                                due.insert(root, Instant::now() + DEBOUNCE);
                            }
                            Trigger::None => {}
                        },
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            eprintln!("loop thread.plan: lagged {n} events");
                        }
                        Err(broadcast::error::RecvError::Closed) => return,
                    },
                    _ = async {
                        match next {
                            Some(at) => tokio::time::sleep_until(at).await,
                            None => std::future::pending::<()>().await,
                        }
                    } => {
                        let t = Instant::now();
                        let mut ready: Vec<(String, Instant)> =
                            due.iter().filter(|(_, at)| **at <= t).map(|(r, at)| (r.clone(), *at)).collect();
                        ready.sort_by_key(|(_, at)| *at);
                        for (r, _) in ready {
                            due.remove(&r);
                            now_jobs.push_back(Job::Changed(r));
                        }
                    }
                }
                continue;
            }
            let Some(job) = now_jobs.pop_front() else {
                continue;
            };
            let res = run_gated(&gate, "thread.plan", Side::Rust, || async {
                if let Err(e) = w.run(&job).await {
                    eprintln!("loop thread.plan: {job:?} failed: {e}");
                }
                Ok::<(), sqlx::Error>(())
            })
            .await;
            match res {
                // 다른 Rust 프로세스가 잡고 있다 — 버리지 않고 잠시 뒤 다시.
                GateResult::Locked => {
                    now_jobs.push_front(job);
                    tokio::time::sleep(DEBOUNCE).await;
                }
                GateResult::Gate(e) => eprintln!("loop thread.plan: gate failed: {e}"),
                _ => {}
            }
        }
    })
}

#[cfg(test)]
#[path = "thread_plan_tests.rs"]
mod tests;
