//! 스레드당 하네스 세션 기록(`sessions.ts` 의 `SessionRecord`·`SessionStore`, B4-2d).
//!
//! 러너는 멘션마다 하네스를 새로 띄우고 버린다 — 여기 적어 두지 않으면 에이전트는 자기 스레드를
//! 매번 처음 보는 것처럼 대한다. 기록은 상태일 뿐이다(작업 폴더·세션 id·먹인 커서). 파일 꼴은
//! 정본 `sessions.json` 과 같아서 TS 러너와 Rust 러너가 같은 파일을 번갈아 읽어도 세션을 잃지 않는다.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use crate::adapter::AgentHarness;
use crate::link::random_uuid;

/// 정본 `SessionRecord`. 옵셔널 칸은 그 칸 이전에 쓰인 옛 레코드가 디스크에 있어서다 —
/// 필수로 하면 러너가 뜨면서 모든 스레드의 세션을 조용히 잃는다.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub workspace_dir: String,
    /// codex 는 첫 턴이 끝나야 id 를 안다 — `None` 은 "아직 못 돌렸다"이지 고장이 아니다.
    pub session_id: Option<String>,
    #[serde(with = "harness_str")]
    pub harness: AgentHarness,
    /// 이 세션에 마지막으로 먹인 스레드 seq.
    pub last_fed_seq: u64,
    /// 이 세션으로 실제로 하네스를 돌린 횟수(`last_fed_seq` 에서 유도하지 않는다).
    pub turns_run: u64,
    /// 세션을 만든 claude 계정. 옛 레코드의 `undefined` 와 `null` 은 같은 상태라 하나로 읽는다.
    #[serde(default)]
    pub claude_account: Option<String>,
    /// 그 계정의 풀. **바깥 `None` = 이 칸 이전의 옛 레코드**(풀을 재지 않는다), `Some(None)` = 풀 없음.
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub claude_pool: Option<Option<String>>,
    /// 깨움 세션이 쓴 내 발화가 이 seq 뒤에 있다 — 다음 이어받는 턴이 보여 준 뒤 지운다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unseen_own_after_seq: Option<u64>,
    /// 앞 턴을 사람이 멈췄다 — 누른 사람의 handle. 다음 턴이 답하면 지운다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canceled_by: Option<String>,
}

fn double_option<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

mod harness_str {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    use crate::adapter::AgentHarness;

    pub fn serialize<S: Serializer>(h: &AgentHarness, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(h.as_str())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<AgentHarness, D::Error> {
        let s = String::deserialize(d)?;
        AgentHarness::parse(&s).ok_or_else(|| D::Error::custom(format!("unknown harness {s}")))
    }
}

/// 정본 `isSessionRecord` + 읽기. JSON 숫자가 정수가 아니거나 음수면 버린다(정본은 `number` 면 받지만
/// 커서·횟수가 소수나 음수인 기록은 쓸 데가 없다 — 그 레코드만 버리고 나머지는 살린다).
pub fn parse_record(v: &Value) -> Option<SessionRecord> {
    let obj = v.as_object()?;
    // 정본처럼 각 옵셔널 칸의 꼴을 본다: 문자열·null·없음만.
    for k in ["claudeAccount", "claudePool"] {
        if let Some(x) = obj.get(k)
            && !(x.is_null() || x.is_string())
        {
            return None;
        }
    }
    serde_json::from_value(v.clone()).ok()
}

/// 정본 `SessionStore`. 오퍼레이터처럼 std::thread 구조라 잠금 하나로 쓰기를 직렬화한다 —
/// 파일 쓰기는 잠근 채로 한다(정본의 `writeQueue` 와 같은 순서 보장).
pub struct SessionStore {
    file: PathBuf,
    sessions: Mutex<BTreeMap<String, SessionRecord>>,
}

impl SessionStore {
    pub fn new(file: impl Into<PathBuf>) -> Self {
        Self {
            file: file.into(),
            sessions: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.file
    }

    /// 정본 `load`. 없으면 빈 상태(첫 기동은 정상), 못 읽으면 경고 뒤 빈 상태(러너가 못 뜨는 것보다 낫다),
    /// 파싱 실패·맵이 아닌 꼴이면 원본을 `.broken-<ms>` 로 치우고 빈 상태. 깨진 레코드는 그것만 버린다.
    pub fn load(&self) {
        let loaded = match fs::read_to_string(&self.file) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => {
                eprintln!(
                    "[sessions] {} 읽기 실패({e}) — 빈 상태로 시작한다",
                    self.file.display()
                );
                BTreeMap::new()
            }
            Ok(raw) => match serde_json::from_str::<Value>(&raw) {
                Err(_) => self.quarantine("JSON 파싱 실패"),
                Ok(Value::Object(map)) => {
                    let mut out = BTreeMap::new();
                    for (key, value) in map {
                        match parse_record(&value) {
                            Some(rec) => {
                                out.insert(key, rec);
                            }
                            None => eprintln!(
                                "[sessions] {} 의 '{key}' 레코드가 SessionRecord 모양이 아니다 — 이 레코드만 버린다",
                                self.file.display()
                            ),
                        }
                    }
                    out
                }
                Ok(_) => self.quarantine("최상위가 세션 맵(객체) 형태가 아니다"),
            },
        };
        *self.lock() = loaded;
    }

    fn quarantine(&self, reason: &str) -> BTreeMap<String, SessionRecord> {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let backup = PathBuf::from(format!("{}.broken-{ms}", self.file.display()));
        let _ = fs::rename(&self.file, &backup);
        eprintln!(
            "[sessions] {} 문제({reason}) — 빈 상태로 시작한다 (원본은 {} 에 보존)",
            self.file.display(),
            backup.display()
        );
        BTreeMap::new()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, SessionRecord>> {
        self.sessions.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn get(&self, key: &str) -> Option<SessionRecord> {
        self.lock().get(key).cloned()
    }

    pub fn entries(&self) -> Vec<(String, SessionRecord)> {
        self.lock()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    pub fn put(&self, key: &str, rec: SessionRecord) -> std::io::Result<()> {
        let mut guard = self.lock();
        guard.insert(key.to_string(), rec);
        flush(&self.file, &guard)
    }

    /// 레코드를 뺀다 — 없던 키면 쓰지 않는다.
    pub fn delete(&self, key: &str) -> std::io::Result<()> {
        let mut guard = self.lock();
        if guard.remove(key).is_none() {
            return Ok(());
        }
        flush(&self.file, &guard)
    }
}

/// 유일한 tmp 이름에 0o600 으로 다 쓴 뒤 rename — 쓰는 도중 죽어도 기존 파일은 온전하다.
fn flush(file: &Path, sessions: &BTreeMap<String, SessionRecord>) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut map = Map::new();
    for (k, v) in sessions {
        map.insert(
            k.clone(),
            serde_json::to_value(v).map_err(std::io::Error::other)?,
        );
    }
    let body = serde_json::to_string_pretty(&Value::Object(map)).map_err(std::io::Error::other)?;
    let tmp = PathBuf::from(format!("{}.{}.tmp", file.display(), random_uuid()));
    let res = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, file)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

#[cfg(test)]
#[path = "session_store_tests.rs"]
mod tests;
