//! 푸시 발송 sweep(S5.3 C5e-2) — TS `services/push/pushJobs.ts` 의 `createPushSweeper` 를 옮긴다.
//!
//! - 5초마다 문지기(이름 `push`) 아래서 최대 [`PUSH_SWEEP_BATCH`] 건. 한 건은 한 트랜잭션에서: 때가 된 job 하나를
//!   `for update skip locked` 로 집고 → **보내기 직전 다시 확인**(`live`, security G1·G2) → 기기·분류·소리·배지·이름 → job 을 지우고
//!   커밋. 네트워크(APNs)는 커밋 뒤, 트랜잭션 밖이다. 재시도가 필요한 기기만 새 job 으로 돌아온다([`settle`]).
//! - SQL 은 전부 TS 의 `PUSH_SQL`·`LEAK_NEEDLES_SQL` 그대로다(`golden/push_sql.json`, TS `rustPushSqlGolden.test.ts` 가 씀).
//!   uuid 칸은 Rust 쪽 바깥 select 가 `::text` 로 읽는다.
//! - 미리보기 누출 검사: 에이전트의 글이면 그 에이전트에 걸린 비밀의 현재 값을 키링으로 열어 본문에서 찾는다(TS `secretLeakGuard`).
//!   걸리면 미리보기를 통째로 뺀다.
//! - 이중 실행: 평소엔 문지기가 한쪽만 돌린다. 그 아래에서도 job 행 잠금(`skip locked`) + 커밋 전 delete 가 한 job 을 한 번만
//!   보낸다. 소리 자리는 한 문장 upsert 라 둘 다 울리지 않는다.
use super::{GateResult, Side, run_gated};
use crate::core::mention_parse::mention_token_keys;
use crate::push::apns::{ApnsEnv, ApnsResult, ApnsSendInput, ApnsTransport, redact_token};
use crate::push::payload::{
    ClassifyInput, PUSH_REPLY_SOUND_WINDOW_MS, PUSH_URGENT_WINDOW_MS, PayloadInput, PushKind,
    PushReason, build_push_payload, classify_push, is_urgent, push_collapse_id, push_thread_key,
};
use crate::secrets::keyring::{
    SecretAad, SecretBytes, SecretKeyring, SecretKind, load_secret_keys,
};
use crate::secrets::leak::{LeakHit, LeakSecret, find_in_texts};
use serde_json::Value;
use sqlx::{PgConnection, PgPool, Row};
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

/// TS `SWEEP_INTERVAL_MS`.
pub const PUSH_SWEEP_INTERVAL: Duration = Duration::from_secs(5);
/// TS `SWEEP_BATCH`.
pub const PUSH_SWEEP_BATCH: usize = 50;
/// TS `PUSH_SOUND_PRUNE_EVERY_MS`.
pub const PUSH_SOUND_PRUNE_EVERY: Duration = Duration::from_secs(60 * 60);

/// 이 루프가 쓰는 권한 — 운영 GRANT 와 같아야 한다. 하나라도 없으면 `main.rs` 가 루프를 띄우지 않는다(TS 에 남는다).
/// `for update` 잠금은 그 표의 UPDATE 권한을 요구한다. 읽기(session·inbox·secret* 등)도 쓰기 역할로 하므로 함께 본다.
pub const PUSH_PRIVILEGES: &[(&str, &str)] = &[
    ("push_job", "SELECT"),
    ("push_job", "UPDATE"),
    ("push_job", "DELETE"),
    ("push_job", "INSERT"),
    ("push_device", "SELECT"),
    ("push_device", "DELETE"),
    ("push_device.last_ok_at", "UPDATE"),
    ("push_device.last_error", "UPDATE"),
    ("push_thread_sound", "SELECT"),
    ("push_thread_sound", "INSERT"),
    ("push_thread_sound.sounded_at", "UPDATE"),
    ("push_thread_sound", "DELETE"),
    ("session", "SELECT"),
    ("inbox", "SELECT"),
    ("channel_pref", "SELECT"),
    ("channel_member", "SELECT"),
    ("handle_group", "SELECT"),
    ("agent_team", "SELECT"),
    ("secret_grant", "SELECT"),
    ("secret", "SELECT"),
    ("secret_version", "SELECT"),
];

struct Golden {
    sql: HashMap<String, String>,
    retry_delays_sec: Vec<i32>,
}

static GOLDEN: LazyLock<Golden> = LazyLock::new(|| {
    let v: Value = serde_json::from_str(include_str!("../../golden/push_sql.json"))
        .expect("golden/push_sql.json");
    let sql = v["sql"]
        .as_object()
        .expect("golden sql")
        .iter()
        .map(|(k, s)| (k.clone(), s.as_str().expect("golden sql str").to_string()))
        .collect();
    let retry_delays_sec = v["retryDelaysSec"]
        .as_array()
        .expect("golden retryDelaysSec")
        .iter()
        .map(|n| n.as_i64().expect("retry delay") as i32)
        .collect();
    Golden {
        sql,
        retry_delays_sec,
    }
});

fn g(name: &str) -> &'static str {
    GOLDEN
        .sql
        .get(name)
        .unwrap_or_else(|| panic!("golden push sql {name}"))
        .as_str()
}

/// TS `PUSH_RETRY_DELAYS_SEC`(골든에서).
pub fn retry_delays_sec() -> &'static [i32] {
    &GOLDEN.retry_delays_sec
}

/// 바깥 select 로 감싼 문장들 — uuid·bigint 칸을 text 로 읽는다(sqlx 에 uuid 형을 들이지 않는다).
struct Wrapped {
    pick: String,
    live: String,
    devices: String,
    leak: String,
    handles_account: String,
    handles_group: String,
    handles_team: String,
}

static WRAPPED: LazyLock<Wrapped> = LazyLock::new(|| Wrapped {
    pick: format!(
        "select q.id, q.\"accountId\"::text, q.\"messageId\"::text, q.\"inboxId\"::text, q.reason, \
         q.\"deviceId\"::text, q.attempts from ({}) q",
        g("pick")
    ),
    live: format!(
        "select q.\"channelId\"::text, q.\"threadRootId\"::text, q.body, q.\"authorId\"::text, q.\"authorHandle\", \
         q.\"authorKind\", q.\"channelKind\", q.\"channelName\", q.\"metaKind\", q.\"failureCode\", q.\"optionCount\", \
         q.\"mineThread\" from ({}) q",
        g("live")
    ),
    devices: format!(
        "select q.id::text, q.token, q.env, q.preview, q.badge from ({}) q",
        g("devices")
    ),
    leak: format!(
        "select q.id::text, q.name, q.kind, q.version::int8, q.sealed from ({}) q",
        g("leakNeedles")
    ),
    handles_account: format!(
        "select q.id::text, q.handle from ({}) q",
        g("handlesAccount")
    ),
    handles_group: format!("select q.id::text, q.handle from ({}) q", g("handlesGroup")),
    handles_team: format!("select q.id::text, q.name from ({}) q", g("handlesTeam")),
});

/// 보내는 길 — 운영은 [`ApnsTransport`], 시험은 가짜.
pub trait PushSender: Send + Sync + 'static {
    fn send<'a>(&'a self, input: ApnsSendInput<'a>)
    -> impl Future<Output = ApnsResult> + Send + 'a;
}

impl PushSender for ApnsTransport {
    fn send<'a>(
        &'a self,
        input: ApnsSendInput<'a>,
    ) -> impl Future<Output = ApnsResult> + Send + 'a {
        ApnsTransport::send(self, input)
    }
}

/// 미리보기 누출 검사(TS `secretLeakGuard.findInTexts`). 키링이 없으면 꺼짐 — 그때는 봉인된 비밀이 하나도 없을 때만
/// 루프를 띄운다(`main.rs`, fail-closed).
pub struct LeakGuard(Option<SecretKeyring>);

impl LeakGuard {
    pub fn off() -> Self {
        Self(None)
    }

    /// 키 디렉터리·활성 kid 로 연다(TS `loadSecretKeys` 와 같은 env). 값이 없으면 `Ok(off)`. 오류 글귀에는 파일 이름·kid 만 있다.
    pub fn load(dir: Option<&str>, active: Option<&str>) -> Result<Self, String> {
        let loaded = load_secret_keys(dir, active).map_err(|e| format!("{e}"))?;
        match loaded {
            None => Ok(Self(None)),
            Some(l) => SecretKeyring::new(l)
                .map(|k| Self(Some(k)))
                .map_err(|e| format!("{e}")),
        }
    }

    /// env(`HARKROOM_SECRET_KEYS_DIR` 등)로 읽어 DB 키 확인값과 맞춘 키링 — 비밀 REST 와 같은 공용 로더
    /// ([`crate::secrets::verify::load_verified_from_env`], TS `verifySecretKeys` 뒤의 `createSecretLeakGuard`).
    /// 확인값과 맞지 않는 kid 는 빠지고, 활성 kid 가 어긋나면 꺼짐이다. 오류 글귀에는 파일 이름·kid 만 있다.
    pub async fn from_env_verified(pool: &PgPool) -> Result<Self, String> {
        let verified = crate::secrets::verify::load_verified_from_env(pool).await?;
        Ok(Self(verified.and_then(|v| {
            if !v.rejected_kids.is_empty() {
                eprintln!(
                    "front: push leak guard — secret keys rejected by key check: {:?}",
                    v.rejected_kids
                );
            }
            v.keyring
        })))
    }

    pub fn is_on(&self) -> bool {
        self.0.is_some()
    }

    /// TS `needles` + `findInTexts` — 걸린 비밀(id·이름). 글이 [`crate::secrets::leak`] 하한보다 짧으면 비어 있다.
    async fn find(&self, pool: &PgPool, agent_id: &str, body: &str) -> sqlx::Result<Vec<LeakHit>> {
        let Some(keyring) = &self.0 else {
            return Ok(vec![]);
        };
        if body.encode_utf16().count() < 8 {
            return Ok(vec![]);
        }
        let rows = sqlx::query(WRAPPED.leak.as_str())
            .bind(agent_id)
            .fetch_all(pool)
            .await?;
        let mut secrets = Vec::with_capacity(rows.len());
        for r in rows {
            let id: String = r.get(0);
            let name: String = r.get(1);
            let kind = match r.get::<String, _>(2).as_str() {
                "file" => SecretKind::File,
                _ => SecretKind::Text,
            };
            let version: i64 = r.get(3);
            let sealed: String = r.get(4);
            let Some(value): Option<SecretBytes> = keyring.open(
                &sealed,
                &SecretAad {
                    secret_id: &id,
                    version,
                    kind,
                },
            ) else {
                continue;
            };
            secrets.push(LeakSecret::new(LeakHit { id, name }, value));
        }
        Ok(find_in_texts(&secrets, &[body]))
    }
}

/// 403(설정 탓)을 받았으면 참 — 다음 200 이 풀어 준다(TS `health()`).
#[derive(Default)]
pub struct PushHealth {
    degraded: AtomicBool,
}

impl PushHealth {
    pub fn degraded(&self) -> bool {
        self.degraded.load(Ordering::Relaxed)
    }
}

#[derive(Debug, Clone)]
struct Job {
    id: i64,
    account_id: String,
    message_id: String,
    inbox_id: Option<String>,
    reason: PushReason,
    reason_raw: String,
    device_id: Option<String>,
    attempts: i32,
}

struct Live {
    channel_id: String,
    thread_root_id: Option<String>,
    body: String,
    author_id: String,
    author_handle: Option<String>,
    author_is_agent: bool,
    channel_is_dm: bool,
    channel_name: String,
    meta_kind: Option<String>,
    failure_code: Option<String>,
    option_count: i64,
    mine_thread: bool,
}

struct Device {
    id: String,
    token: String,
    env: ApnsEnv,
    preview: bool,
    badge: bool,
}

/// sweeper — TS `createPushSweeper` 의 상태(소리 기록 정리 시각·degraded).
pub struct PushSweeper<S: PushSender> {
    pool: PgPool,
    sender: S,
    guard: LeakGuard,
    pub health: Arc<PushHealth>,
    pruned_at: Mutex<Option<Instant>>,
}

impl<S: PushSender> PushSweeper<S> {
    pub fn new(pool: PgPool, sender: S, guard: LeakGuard) -> Self {
        Self {
            pool,
            sender,
            guard,
            health: Arc::new(PushHealth::default()),
            pruned_at: Mutex::new(None),
        }
    }

    /// TS `sweep` — 한 tick. 보낸(집은) job 수.
    pub async fn sweep(&self) -> sqlx::Result<usize> {
        let mut skip: Vec<i64> = vec![];
        let mut n = 0;
        for _ in 0..PUSH_SWEEP_BATCH {
            if !self.send_one(&mut skip).await? {
                break;
            }
            n += 1;
        }
        self.prune_sounds().await?;
        Ok(n)
    }

    async fn prune_sounds(&self) -> sqlx::Result<()> {
        {
            let mut at = self.pruned_at.lock().expect("pruned_at");
            if at.is_some_and(|t| t.elapsed() < PUSH_SOUND_PRUNE_EVERY) {
                return Ok(());
            }
            *at = Some(Instant::now());
        }
        sqlx::query(g("pruneSounds")).execute(&self.pool).await?;
        Ok(())
    }

    /// TS `sendOne` — job 이 없으면 `false`.
    async fn send_one(&self, skip: &mut Vec<i64>) -> sqlx::Result<bool> {
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query(WRAPPED.pick.as_str())
            .bind(&*skip)
            .fetch_optional(&mut *tx)
            .await?;
        let Some(row) = row else {
            tx.commit().await?;
            return Ok(false);
        };
        let reason_raw: String = row.get(4);
        let job = Job {
            id: row.get(0),
            account_id: row.get(1),
            message_id: row.get(2),
            inbox_id: row.get(3),
            reason: PushReason::parse(&reason_raw).unwrap_or(PushReason::Mention),
            reason_raw,
            device_id: row.get(5),
            attempts: row.get(6),
        };
        skip.push(job.id);
        // 모르는 사유(스키마 밖)는 보내지 않고 지운다 — TS 는 PREF_KEY 가 undefined 가 되어 기기가 다 걸러진다.
        let known = PushReason::parse(&job.reason_raw).is_some();
        let prepared = if known {
            self.prepare(&mut tx, &job).await?
        } else {
            None
        };
        // 집은 job 은 여기서 지운다 — 다시 보낼 것은 기기 단위의 새 job 으로 돌아온다.
        sqlx::query(g("deleteJob"))
            .bind(job.id.to_string())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        let Some(p) = prepared else {
            return Ok(true);
        };

        let preview = if p.devices.iter().any(|d| d.preview) {
            self.safe_preview(&p.live).await?
        } else {
            None
        };
        let collapse = push_collapse_id(p.kind, &p.thread_key, &job.message_id);
        for device in &p.devices {
            let payload = build_push_payload(&PayloadInput {
                kind: p.kind,
                account_id: &job.account_id,
                message_id: &job.message_id,
                channel_id: &p.live.channel_id,
                thread_root_id: p.live.thread_root_id.as_deref(),
                author_handle: p.live.author_handle.as_deref(),
                channel_name: (!p.live.channel_is_dm).then_some(p.live.channel_name.as_str()),
                badge: device.badge.then_some(p.badge),
                preview_body: if device.preview {
                    preview.as_deref()
                } else {
                    None
                },
                id_to_handle: &p.id_to_handle,
                reply_count: p.reply_count,
                option_count: p.live.option_count,
                sound: p.sound,
            });
            let result = self
                .sender
                .send(ApnsSendInput {
                    token: &device.token,
                    env: device.env,
                    payload: &payload,
                    collapse_id: &collapse,
                })
                .await;
            self.settle(&job, device, &result).await?;
        }
        Ok(true)
    }

    async fn prepare(&self, tx: &mut PgConnection, job: &Job) -> sqlx::Result<Option<Prepared>> {
        let Some(r) = sqlx::query(WRAPPED.live.as_str())
            .bind(job.id.to_string())
            .fetch_optional(&mut *tx)
            .await?
        else {
            return Ok(None);
        };
        let live = Live {
            channel_id: r.get(0),
            thread_root_id: r.get(1),
            body: r.get::<Option<String>, _>(2).unwrap_or_default(),
            author_id: r.get(3),
            author_handle: r.get(4),
            author_is_agent: r.get::<String, _>(5) == "agent",
            channel_is_dm: r.get::<String, _>(6) == "dm",
            channel_name: r.get::<Option<String>, _>(7).unwrap_or_default(),
            meta_kind: r.get(8),
            failure_code: r.get(9),
            option_count: i64::from(r.get::<i32, _>(10)),
            mine_thread: r.get::<Option<bool>, _>(11).unwrap_or(false),
        };
        let devices: Vec<Device> = sqlx::query(WRAPPED.devices.as_str())
            .bind(&job.account_id)
            .bind(job.reason.pref_key())
            .bind(job.device_id.as_deref())
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .filter_map(|d| {
                Some(Device {
                    id: d.get(0),
                    token: d.get(1),
                    // 모르는 환경 값은 보내지 않는다(스키마 check 가 막지만 한 번 더).
                    env: ApnsEnv::parse(&d.get::<String, _>(2))?,
                    preview: d.get(3),
                    badge: d.get(4),
                })
            })
            .collect();
        if devices.is_empty() {
            return Ok(None);
        }
        let kind = classify_push(&ClassifyInput {
            reason: job.reason,
            author_is_agent: live.author_is_agent,
            meta_kind: live.meta_kind.as_deref(),
            failure_code: live.failure_code.as_deref(),
            mine_thread: live.mine_thread,
        });
        let thread_key = push_thread_key(
            &live.channel_id,
            (!live.channel_is_dm).then_some(live.channel_name.as_str()),
            live.thread_root_id.as_deref(),
            &job.message_id,
        )
        .to_string();
        let mut reply_count = 0;
        let sound = if kind == PushKind::AgentReply {
            reply_count = match &live.thread_root_id {
                Some(root) => {
                    sqlx::query_scalar::<_, i64>(g("replies"))
                        .bind(&job.account_id)
                        .bind(root)
                        .fetch_one(&mut *tx)
                        .await?
                }
                None => 1,
            };
            // 재시도(device_id 가 찬 job)는 이미 첫 시도에서 정한 몫이다 — 시각을 다시 적지 않고 조용히 보낸다.
            job.device_id.is_none()
                && claim_sound(tx, &job.account_id, &thread_key, PUSH_REPLY_SOUND_WINDOW_MS).await?
        } else if is_urgent(kind) {
            claim_sound(
                tx,
                &job.account_id,
                &format!("urgent:{thread_key}"),
                PUSH_URGENT_WINDOW_MS,
            )
            .await?
        } else {
            true
        };
        let badge = sqlx::query_scalar::<_, i64>(g("badge"))
            .bind(&job.account_id)
            .fetch_one(&mut *tx)
            .await?;
        let id_to_handle = if devices.iter().any(|d| d.preview) {
            handles_for(tx, &live.body).await?
        } else {
            HashMap::new()
        };
        Ok(Some(Prepared {
            live,
            devices,
            kind,
            thread_key,
            reply_count,
            sound,
            badge,
            id_to_handle,
        }))
    }

    /// TS `safePreview` — 에이전트의 글에 그 에이전트의 비밀 값이 있으면 미리보기를 뺀다.
    async fn safe_preview(&self, live: &Live) -> sqlx::Result<Option<String>> {
        if live.author_is_agent
            && !self
                .guard
                .find(&self.pool, &live.author_id, &live.body)
                .await?
                .is_empty()
        {
            return Ok(None);
        }
        Ok(Some(live.body.clone()))
    }

    /// TS `settle` — 기기 하나의 결과 정리.
    async fn settle(&self, job: &Job, device: &Device, r: &ApnsResult) -> sqlx::Result<()> {
        let status = r.status;
        if status == 200 {
            self.health.degraded.store(false, Ordering::Relaxed);
            sqlx::query(g("deviceOk"))
                .bind(&device.id)
                .execute(&self.pool)
                .await?;
            return Ok(());
        }
        let label = match &r.reason {
            Some(reason) => format!("{status} {reason}"),
            None => status.to_string(),
        };
        let reason = r.reason.as_deref();
        // 기기가 없어졌다(앱 삭제·토큰 교체) → 행을 지운다. 다시 등록하면 돌아온다.
        if status == 410
            || (status == 400
                && matches!(reason, Some("BadDeviceToken" | "DeviceTokenNotForTopic")))
        {
            sqlx::query(g("deviceRemove"))
                .bind(&device.id)
                .execute(&self.pool)
                .await?;
            eprintln!(
                "[push] device {} removed ({label})",
                redact_token(&device.token)
            );
            return Ok(());
        }
        let set_error = || {
            sqlx::query(g("deviceError"))
                .bind(&device.id)
                .bind(&label)
                .execute(&self.pool)
        };
        if status == 403 {
            // 설정 오류(키·팀·topic). 토큰은 멀쩡하므로 지우지 않는다.
            self.health.degraded.store(true, Ordering::Relaxed);
            set_error().await?;
            eprintln!("[push] provider rejected ({label}) — check APNS_* settings");
            return Ok(());
        }
        if status == 0 || status == 429 || status >= 500 {
            set_error().await?;
            match usize::try_from(job.attempts)
                .ok()
                .and_then(|i| retry_delays_sec().get(i))
            {
                Some(next) => {
                    // inbox 를 그대로 잇는다 — 재시도 사이에 읽으면 다시 확인에서 걸린다.
                    sqlx::query(g("retry"))
                        .bind(&job.account_id)
                        .bind(&job.message_id)
                        .bind(job.inbox_id.as_deref())
                        .bind(&device.id)
                        .bind(&job.reason_raw)
                        .bind((job.attempts + 1).to_string())
                        .bind(next.to_string())
                        .execute(&self.pool)
                        .await?;
                }
                None => eprintln!(
                    "[push] device {} gave up after {} retries ({label})",
                    redact_token(&device.token),
                    job.attempts
                ),
            }
            return Ok(());
        }
        set_error().await?;
        eprintln!(
            "[push] device {} rejected ({label})",
            redact_token(&device.token)
        );
        Ok(())
    }
}

struct Prepared {
    live: Live,
    devices: Vec<Device>,
    kind: PushKind,
    thread_key: String,
    reply_count: i64,
    sound: bool,
    badge: i64,
    id_to_handle: HashMap<String, String>,
}

/// TS `claimSound` — 한 문장 upsert 라 sweeper 가 둘이어도 둘 다 울리지 않는다.
async fn claim_sound(
    tx: &mut PgConnection,
    account_id: &str,
    thread_key: &str,
    window_ms: u64,
) -> sqlx::Result<bool> {
    let r = sqlx::query(g("claimSound"))
        .bind(account_id)
        .bind(thread_key)
        .bind((window_ms as f64 / 1000.0).to_string())
        .execute(&mut *tx)
        .await?;
    Ok(r.rows_affected() > 0)
}

/// TS `handlesFor` — 본문의 토큰을 지금 이름으로 바꿀 지도.
async fn handles_for(tx: &mut PgConnection, body: &str) -> sqlx::Result<HashMap<String, String>> {
    let keys = mention_token_keys(body);
    let mut map = HashMap::new();
    if keys.is_empty() {
        return Ok(map);
    }
    let plain: Vec<String> = keys.iter().filter(|k| !k.contains(':')).cloned().collect();
    let group: Vec<String> = keys
        .iter()
        .filter_map(|k| k.strip_prefix("group:").map(str::to_string))
        .collect();
    let team: Vec<String> = keys
        .iter()
        .filter_map(|k| k.strip_prefix("team:").map(str::to_string))
        .collect();
    for (sql, ids, prefix) in [
        (WRAPPED.handles_account.as_str(), &plain, ""),
        (WRAPPED.handles_group.as_str(), &group, "group:"),
        (WRAPPED.handles_team.as_str(), &team, "team:"),
    ] {
        if ids.is_empty() {
            continue;
        }
        for r in sqlx::query(sql).bind(ids).fetch_all(&mut *tx).await? {
            let id: String = r.get(0);
            map.insert(format!("{prefix}{id}"), r.get::<String, _>(1));
        }
    }
    Ok(map)
}

/// 루프를 띄운다 — 5초마다. 주인이 `rust` 일 때만 실제로 돈다. `gate` 는 문지기(잠금) 연결 전용 풀이다.
pub fn spawn<S: PushSender>(
    gate: PgPool,
    sweeper: Arc<PushSweeper<S>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(PUSH_SWEEP_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // TS 는 setInterval 이라 첫 sweep 은 5초 뒤다.
        every.tick().await;
        loop {
            every.tick().await;
            let s = &sweeper;
            match run_gated(&gate, "push", Side::Rust, || async move {
                s.sweep().await.map(|_| ())
            })
            .await
            {
                // 오류 문구만(행 내용·토큰 없음).
                GateResult::Gate(e) => eprintln!("loop push: gate failed: {e}"),
                GateResult::Sweep(e) => eprintln!("loop push: sweep failed: {e}"),
                _ => {}
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_has_every_statement() {
        for k in [
            "live",
            "devices",
            "badge",
            "replies",
            "claimSound",
            "pick",
            "deleteJob",
            "deviceOk",
            "deviceRemove",
            "deviceError",
            "retry",
            "handlesAccount",
            "handlesGroup",
            "handlesTeam",
            "pruneSounds",
            "leakNeedles",
        ] {
            assert!(!g(k).is_empty(), "{k}");
        }
        assert_eq!(retry_delays_sec(), &[30, 120, 600]);
        // 바깥 select 가 감쌀 수 있게 끝에 `;` 가 없어야 한다.
        assert!(!WRAPPED.pick.contains(';'));
        assert!(!WRAPPED.live.trim_end().ends_with(';'));
    }
}
