//! 고아 러너 채택 판정(s21c-2b-1) — 장부(`runner_ledger.rs`)가 준 후보 하나하나에 「정말 그 러너인가」를 묻고,
//! 답이 확실할 때만 채택한다. 정본은 `packages/operator/src/adopt.ts` 다.
//!
//! **채택은 죽일 권한이다** — 채택된 러너는 `killRunner` 의 대상이 되므로, 잘못 채택하면 무관한 프로세스에 SIGTERM 이 간다.
//! 그래서 모든 판정이 한쪽으로 기운다: **확실하지 않으면 채택하지 않는다.**
//!
//! **옮긴 성질**(TS 와 같다):
//! - 후보의 출처는 이 오퍼레이터 `appDataDir` 아래 장부 하나뿐이다 — 프로세스 목록을 훑지 않는다(남의 러너가 후보에 오를 길이 없다).
//! - pid 재사용은 **커널 시작 시각**(`ps -o lstart= -p <pid>`, 1초 해상도)으로 가린다. 장부의 `bootTimeSec` 이 없거나(None),
//!   지금 값을 못 읽거나, 다르면 채택하지 않는다. `startedAtMs`(오퍼레이터 시계)는 축으로 쓰지 않는다(창이 필요해진다).
//! - 순서: 생사 → 장부의 시작 시각 유무 → 지금 시작 시각 대조. 세대(앱 버전) 판정은 **신원 판정 뒤**다 —
//!   죽었거나 재사용된 pid 에 세대를 물으면 회수(`retire`)가 무관한 프로세스에 SIGTERM 을 보낼 수 있다.
//! - 지금 앱 버전을 모르면 세대 판정을 하지 않는다. 장부에 세대가 없으면 낡은 것으로 본다.
//! - 한 에이전트에 줄이 여럿이면 `startedAtMs` 최신 하나만 채택한다. 회수 중(`retiring`) 줄은 그 다툼에 끼지 않고,
//!   신원을 똑같이 물은 뒤 `Retiring` 으로 돌린다.
//! - 판정 사유는 값으로 흐르고(`Verdict`), `describe_verdict` 가 사람이 읽을 로그 한 줄을 만든다.
//!
//! **TS 와 다른 점**: `ps` 시각 해석 — TS 는 `Date.parse(lstart)`(지역 시각)이고, 여기는 `LC_ALL=C` 로 영어 꼴을 받아
//! `mktime`(지역 시각, `tm_isdst=-1`)으로 바꾼다. 둘 다 초 단위로 잘라 같은 값이 나온다(시험 `lstart_parses_like_date_parse`).
use crate::runner_ledger::RunnerLedgerEntry;
use std::collections::HashMap;
use std::process::{Command, Stdio};

/// 프로세스 신원을 묻는 표면(TS `ProcessIdentityProbe`). 시험이 실물 없이 판정을 밟게 한다.
pub trait IdentityProbe {
    /// 그 pid 의 커널 시작 시각(초 epoch). 없거나 못 읽으면 None — 둘 다 「확인 못 함」이다.
    fn boot_time_sec(&self, pid: i32) -> Option<i64>;
    /// `kill(pid, 0)`.
    fn alive(&self, pid: i32) -> bool;
}

/// 실물 probe — `ps -o lstart= -p <pid>` 한 건만 묻는다(목록을 훑지 않는다).
pub struct PsProbe;

impl IdentityProbe for PsProbe {
    fn boot_time_sec(&self, pid: i32) -> Option<i64> {
        ps_boot_time_sec(pid)
    }
    fn alive(&self, pid: i32) -> bool {
        crate::runners::signal_sent(pid, 0)
    }
}

/// `ps -o lstart= -p <pid>` → 초 epoch. 러너 spawn 직후 장부에 적을 값도 이것으로 읽는다(c2b-2 배선).
pub fn ps_boot_time_sec(pid: i32) -> Option<i64> {
    if pid <= 0 {
        return None;
    }
    let out = Command::new("/bin/ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_lstart(String::from_utf8_lossy(&out.stdout).trim())
}

/// `Wed Nov 11 17:30:56 2026` (C 로캘 `lstart`) → 지역 시각으로 본 초 epoch.
pub fn parse_lstart(text: &str) -> Option<i64> {
    let parts: Vec<&str> = text.split_whitespace().collect();
    let [_, mon, day, hms, year] = parts.as_slice() else {
        return None;
    };
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let mon = MONTHS.iter().position(|m| m == mon)? as i32;
    let day: i32 = day.parse().ok()?;
    let year: i32 = year.parse().ok()?;
    let mut t = hms.split(':').map(|x| x.parse::<i32>().ok());
    let (h, m, s) = (t.next()??, t.next()??, t.next()??);
    if t.next().is_some() || !(1..=31).contains(&day) || h > 23 || m > 59 || s > 60 {
        return None;
    }
    // SAFETY: tm 은 지역 값으로 0 으로 채운 뒤 필드를 넣는다. mktime 은 그 구조체만 읽고 고친다.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = year - 1900;
    tm.tm_mon = mon;
    tm.tm_mday = day;
    tm.tm_hour = h;
    tm.tm_min = m;
    tm.tm_sec = s;
    tm.tm_isdst = -1;
    // SAFETY: 위 tm 은 유효한 구조체다.
    let secs = unsafe { libc::mktime(&mut tm) };
    (secs != -1).then_some(secs as i64)
}

/// 후보 하나에 대한 판정(TS `AdoptionVerdict`).
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Adopt,
    /// `kill(pid, 0)` 실패 — 그 pid 는 없다.
    Dead,
    /// 대조할 축이 없다(장부에 시작 시각 없음·같은 에이전트의 더 최신 줄).
    Unverifiable(String),
    /// 살아는 있는데 시작 시각이 다르거나 못 읽었다 — pid 재사용으로 본다.
    PidReused {
        expected: i64,
        actual: Option<i64>,
    },
    /// 우리 것은 맞는데 다른 앱 세대가 띄웠다 — 채택하지 않고 회수한다.
    StaleGeneration {
        theirs: Option<String>,
        mine: String,
    },
    /// 앞 오퍼레이터가 회수하던 러너 — 다시 회수하고 링크를 받아 남은 턴을 끝내게 한다.
    Retiring,
}

/// TS `judgeCandidate`. 생사를 먼저 묻는다 — `Dead`(정상 종료)와 `PidReused`(위험)를 로그에서 가르기 위해.
pub fn judge_candidate(entry: &RunnerLedgerEntry, probe: &dyn IdentityProbe) -> Verdict {
    if !probe.alive(entry.pid) {
        return Verdict::Dead;
    }
    let Some(expected) = entry.boot_time_sec else {
        return Verdict::Unverifiable(
            "spawn 당시 커널 시작 시각을 기록하지 못했다 — pid 재사용을 가릴 축이 없다".into(),
        );
    };
    match probe.boot_time_sec(entry.pid) {
        Some(actual) if actual == expected => Verdict::Adopt,
        actual => Verdict::PidReused { expected, actual },
    }
}

/// TS `AdoptionPlan`.
#[derive(Debug, Default)]
pub struct AdoptionPlan {
    pub adopt: Vec<RunnerLedgerEntry>,
    /// 채택하지 않은 것들과 사유(`Verdict::Adopt` 는 들지 않는다).
    pub rejected: Vec<(RunnerLedgerEntry, Verdict)>,
}

/// TS `planAdoption`. `my_app_version` 이 None 이면 세대 판정을 하지 않는다.
pub fn plan_adoption(
    entries: &[RunnerLedgerEntry],
    probe: &dyn IdentityProbe,
    my_app_version: Option<&str>,
) -> AdoptionPlan {
    let mut plan = AdoptionPlan::default();
    // 에이전트당 최신 줄의 위치. 같은 startedAtMs 면 앞 줄이 남는다(TS `>` 와 같다).
    let mut latest: HashMap<&str, usize> = HashMap::new();
    for (i, e) in entries.iter().enumerate() {
        if e.retiring.is_some() {
            continue;
        }
        match latest.get(e.agent_id.as_str()) {
            Some(&j) if entries[j].started_at_ms >= e.started_at_ms => {}
            _ => {
                latest.insert(&e.agent_id, i);
            }
        }
    }
    for (i, entry) in entries.iter().enumerate() {
        if entry.retiring.is_some() {
            let v = match judge_candidate(entry, probe) {
                Verdict::Adopt => Verdict::Retiring,
                v => v,
            };
            plan.rejected.push((entry.clone(), v));
            continue;
        }
        if latest.get(entry.agent_id.as_str()) != Some(&i) {
            plan.rejected.push((
                entry.clone(),
                Verdict::Unverifiable(
                    "같은 에이전트에 더 최신 항목이 있다 — 표는 에이전트당 하나다".into(),
                ),
            ));
            continue;
        }
        let verdict = judge_candidate(entry, probe);
        if verdict == Verdict::Adopt {
            if let Some(mine) = my_app_version
                && entry.spawned_by_app_version.as_deref() != Some(mine)
            {
                plan.rejected.push((
                    entry.clone(),
                    Verdict::StaleGeneration {
                        theirs: entry.spawned_by_app_version.clone(),
                        mine: mine.to_string(),
                    },
                ));
                continue;
            }
            plan.adopt.push(entry.clone());
        } else {
            plan.rejected.push((entry.clone(), verdict));
        }
    }
    plan
}

/// TS `describeVerdict` — 사람이 「왜 안 채택했나」를 읽는 로그 한 줄. secret 은 싣지 않는다.
pub fn describe_verdict(entry: &RunnerLedgerEntry, verdict: &Verdict) -> String {
    let head = format!("채택 안 함: agent={} pid={}", entry.agent_id, entry.pid);
    match verdict {
        Verdict::Adopt => format!("채택: agent={} pid={}", entry.agent_id, entry.pid),
        Verdict::Dead => format!("{head} — 그 pid 가 없다(정상적으로 끝난 러너다)"),
        Verdict::Unverifiable(reason) => format!("{head} — {reason}"),
        Verdict::PidReused { expected, actual } => format!(
            "{head} — **pid 가 재사용됐다.** 장부의 시작 시각 {expected}, 지금 그 pid 의 시작 시각 {} — 무관한 프로세스다",
            actual.map_or_else(|| "(못 읽음)".to_string(), |a| a.to_string())
        ),
        Verdict::StaleGeneration { theirs, mine } => format!(
            "{head} — 세대가 다르다(그 러너를 띄운 앱 {}, 지금 앱 {mine}) — 회수하고 배정이 다시 띄운다",
            theirs.as_deref().unwrap_or("(안 적혀 있음)")
        ),
        Verdict::Retiring => format!(
            "{head} — 앞 오퍼레이터가 회수하던 러너다 — 다시 회수하고 링크를 받아 남은 턴을 끝내게 한다"
        ),
    }
}

/// 채택을 실제로 거는 자리들(TS run.ts `adoptOrphans` 가 닿는 registry·runnerLink·로컬 설정). 시험은 가짜를 꽂는다.
pub trait AdoptPorts {
    /// 이 커뮤니티 로컬 설정(`operator.json`)에 그 에이전트가 있나 — 없으면 채택하지 않는다(security c2b-3 ①).
    fn is_local(&self, agent_id: &str) -> bool;
    /// 표에 올린다. 그 자리에 살아 있는 러너가 있어 못 올렸으면 false(`RunnerTable::adopt_runner`).
    fn adopt(&self, entry: &RunnerLedgerEntry) -> bool;
    /// 회수 — SIGTERM 하나(승격 없음). 장부·회수 중 표 기록은 c2c(retiring)가 잇는다.
    fn retire(&self, entry: &RunnerLedgerEntry);
    /// 러너 링크에 그 세대의 secret 을 적는다(`RunnerLink::expect`).
    fn link_expect(&self, runner_id: &str, agent_id: &str, secret: &str);
}

/// TS `adoptOrphans`(run.ts) — 새 장부 + 개명 전 장부를 훑어 고아를 채택하고 낡은 세대·회수 중 러너는 회수한다.
/// 같은 pid 가 둘에 있으면 새 장부가 이긴다. 돌려주는 것은 채택한 agentId 들과 사람이 읽을 거절 사유 줄들.
///
/// **링크 secret 은 그 줄의 `incarnation_id` 와 짝지어서만 적는다**(security ②) — 빈 secret 줄은 링크를 열지 않는다.
pub fn adopt_orphans(
    fresh: Vec<RunnerLedgerEntry>,
    legacy: Vec<RunnerLedgerEntry>,
    probe: &dyn IdentityProbe,
    my_app_version: Option<&str>,
    ports: &dyn AdoptPorts,
) -> (Vec<String>, Vec<String>) {
    let seen: std::collections::HashSet<i32> = fresh.iter().map(|e| e.pid).collect();
    let mut entries = fresh;
    entries.extend(legacy.into_iter().filter(|e| !seen.contains(&e.pid)));
    let mut plan = plan_adoption(&entries, probe, my_app_version);
    let expect = |e: &RunnerLedgerEntry| {
        if let Some(secret) = e.link_secret.as_deref().filter(|s| !s.is_empty()) {
            ports.link_expect(&e.incarnation_id, &e.agent_id, secret);
        }
    };
    for (entry, verdict) in &plan.rejected {
        // 우리 것이 확실한(pid·커널 시작 시각 통과) 낡은 세대·회수 중 러너만 회수한다. 링크도 받는다 —
        // 안 받으면 「모르는 러너」로 거절돼 그 러너가 열린 턴을 끝낼 길이 없다(TS #838).
        if matches!(verdict, Verdict::StaleGeneration { .. } | Verdict::Retiring) {
            ports.retire(entry);
            expect(entry);
        }
    }
    let mut adopted = Vec::new();
    for entry in std::mem::take(&mut plan.adopt) {
        if !ports.is_local(&entry.agent_id) {
            // 로컬 설정에서 빠진 에이전트 — 우리 러너는 맞으니 회수한다(남의 로컬 설정으로 계속 돌지 않게).
            ports.retire(&entry);
            plan.rejected.push((
                entry,
                Verdict::Unverifiable(
                    "이 커뮤니티 로컬 설정에 없는 에이전트다 — 채택하지 않고 회수한다".into(),
                ),
            ));
            continue;
        }
        if !ports.adopt(&entry) {
            plan.rejected.push((
                entry,
                Verdict::Unverifiable("이미 이 오퍼레이터가 아는 러너가 그 자리에 있다".into()),
            ));
            continue;
        }
        expect(&entry);
        adopted.push(entry.agent_id);
    }
    let lines = plan
        .rejected
        .iter()
        .map(|(e, v)| describe_verdict(e, v))
        .collect();
    (adopted, lines)
}

#[cfg(test)]
#[path = "adopt/tests.rs"]
mod tests;
