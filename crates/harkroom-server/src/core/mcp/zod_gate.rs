//! TS 로 넘기기 전 공통 인자 검증 — SDK(1.30, zod 3.25)는 도구 처리기 **앞에서** 인자를 zod 로 검사하고, 틀리면 처리기에 가지 않고
//! `MCP error -32602: Input validation error: Invalid arguments for tool <이름>: <이슈들>`(`isError: true`)을 낸다
//! (`McpServer.validateToolInput` · `getParseErrorMessage`). 이 갈래는 그 글자를 도구마다 따로 쓰지 않고, `tools/list` 골든
//! (`golden/mcp_tools_list.json` — TS 가 등록한 zod 스키마를 SDK 가 JSON 스키마로 옮긴 것)을 읽어 **모든 도구**에 같은 규칙으로 낸다.
//!
//! - 답은 셋이다: [`Verdict::Reject`](zod 가 거절 — 그 글자), [`Verdict::Pass`](zod 가 받음 — 지금처럼 처리기·TS), [`Verdict::Unsure`]
//!   (JSON 스키마만으로는 zod 의 글자를 확정할 수 없음 — `url()`·시간대 있는 `datetime` 등. 지금처럼 TS).
//! - 정본은 TS 다: `packages/server/test/rustMcpZodGolden.test.ts` 가 도구마다 틀린 꼴 수천 개를 **실제 zod 스키마**로 돌린 결과를
//!   `golden/mcp_zod_cases.json` 에 굽고, 이 파일의 시험이 Rust 가 같은 글자를 내는지(못 내면 `Unsure`) 본다 — 다른 글자는 0 이어야 한다.
//! - 이슈 순서는 zod 와 같다: 객체는 스키마 키 순서, 배열은 길이 검사 → 원소. 객체·배열은 한 칸이라도 형이 틀리면 「중단」, 길이·범위만
//!   틀리면 「더러움」이다(union 이 이 둘을 가른다).
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use std::collections::HashMap;

/// 키 순서를 지키는 JSON(골든 스키마용) — `serde_json::Map` 은 키를 abc 순으로 늘어놓아 zod 의 이슈 순서를 잃는다.
#[derive(Debug, Clone)]
enum Oj {
    Null,
    Bool,
    Num(f64),
    Str(String),
    Arr(Vec<Oj>),
    Obj(Vec<(String, Oj)>),
}

impl Oj {
    fn get(&self, k: &str) -> Option<&Oj> {
        match self {
            Oj::Obj(o) => o.iter().find(|(n, _)| n == k).map(|(_, v)| v),
            _ => None,
        }
    }
    fn str(&self) -> Option<&str> {
        match self {
            Oj::Str(s) => Some(s),
            _ => None,
        }
    }
    fn num(&self) -> Option<f64> {
        match self {
            Oj::Num(n) => Some(*n),
            _ => None,
        }
    }
    fn arr(&self) -> &[Oj] {
        match self {
            Oj::Arr(a) => a,
            _ => &[],
        }
    }
    /// JS `JSON.stringify` 꼴(`z.literal` 문구용) — 문자열·수·불·null 만.
    fn js(&self) -> Option<String> {
        match self {
            Oj::Str(s) => Some(Value::from(s.as_str()).to_string()),
            Oj::Num(n) => js_num(*n),
            Oj::Null => Some("null".into()),
            _ => None,
        }
    }
}

impl<'de> Deserialize<'de> for Oj {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Oj;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("json")
            }
            fn visit_unit<E: de::Error>(self) -> Result<Oj, E> {
                Ok(Oj::Null)
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Oj, E> {
                Ok(Oj::Bool)
            }
            fn visit_i64<E: de::Error>(self, n: i64) -> Result<Oj, E> {
                Ok(Oj::Num(n as f64))
            }
            fn visit_u64<E: de::Error>(self, n: u64) -> Result<Oj, E> {
                Ok(Oj::Num(n as f64))
            }
            fn visit_f64<E: de::Error>(self, n: f64) -> Result<Oj, E> {
                Ok(Oj::Num(n))
            }
            fn visit_str<E: de::Error>(self, s: &str) -> Result<Oj, E> {
                Ok(Oj::Str(s.to_owned()))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Oj, A::Error> {
                let mut v = Vec::new();
                while let Some(x) = a.next_element()? {
                    v.push(x);
                }
                Ok(Oj::Arr(v))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Oj, A::Error> {
                let mut v = Vec::new();
                while let Some((k, x)) = a.next_entry::<String, Oj>()? {
                    v.push((k, x));
                }
                Ok(Oj::Obj(v))
            }
        }
        d.deserialize_any(V)
    }
}

/// 도구 이름 → 입력 스키마. `delegation.close` 도 실린 목록(조건부 등록은 부르는 쪽이 거른다).
fn schemas() -> &'static HashMap<String, Oj> {
    static S: std::sync::OnceLock<HashMap<String, Oj>> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        let g: Value = serde_json::from_str(include_str!("../../../golden/mcp_tools_list.json"))
            .expect("golden/mcp_tools_list.json");
        let list: Oj = serde_json::from_str(g["delegation_v2"].as_str().expect("delegation_v2"))
            .expect("tools list");
        let mut m = HashMap::new();
        for t in list.get("tools").map(Oj::arr).unwrap_or(&[]) {
            if let (Some(n), Some(s)) = (t.get("name").and_then(Oj::str), t.get("inputSchema")) {
                m.insert(n.to_owned(), s.clone());
            }
        }
        m
    })
}

/// zod 가 패턴 불일치에 내는 문구가 기본(`Invalid`)이 아닌 패턴 — TS 의 `.regex(re, '<문구>')`. 골든 시험이 맞춘다.
const PATTERN_MESSAGES: &[(&str, &str)] = &[(r"^[\w.-]+\/[\w.-]+$", "owner/name")];

/// JSON 스키마에 실리지 않는 검사 가운데 Rust 가 같은 판정을 내는 것 — TS `tzSchema` 의 `.refine(isTimeZone, 'unknown time zone')`.
/// (도구, 점 경로). 판정은 [`parse_tz`](crate::core::automation_time::parse_tz)가 한다(`Intl` 이 받는 이름과 같다 — 그 모듈 머리 참고).
/// 골든 시험이 「Rust 는 통과라는데 TS 는 거절」인 꼴을 여기 없이 찾아낸다.
const TZ_CHECKS: &[(&str, &str)] = &[("automation.propose", "trigger.tz")];

/// JSON 스키마에 실리지 않는 `.transform()` 이 붙은 칸(도구, 점 경로) — TS `scheduleSchema` 의 `weekdays`(중복 걷고 정렬).
const TRANSFORMS: &[(&str, &str)] = &[("automation.propose", "trigger.weekdays")];

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// zod 가 받는다.
    Pass,
    /// zod 가 거절한다 — `result` 칸의 JSON 글자(SDK `createToolError` 꼴).
    Reject(String),
    /// 글자를 확정할 수 없다 — TS 로.
    Unsure,
}

/// `args` 를 `tool` 의 입력 스키마로 본다. 모르는 도구·인자가 객체가 아님(SDK 의 요청 꼴 검사가 먼저 걸린다)이면 `Unsure`.
pub fn check(tool: &str, args: &Value) -> Verdict {
    let Some(schema) = schemas().get(tool) else {
        return Verdict::Unsure;
    };
    if !args.is_object() {
        return Verdict::Unsure;
    }
    let mut cx = Cx::new(schema, tool);
    let st = cx.node(schema, Some(args), &mut Vec::new());
    let Some(issues) = cx.finish() else {
        return Verdict::Unsure;
    };
    if st == St::Ok {
        return Verdict::Pass;
    }
    if issues.is_empty() {
        return Verdict::Unsure;
    }
    let lines: Vec<String> = issues
        .iter()
        .map(|(p, m)| {
            if p.is_empty() {
                m.clone()
            } else {
                format!("{m} at {}", dot_path(p))
            }
        })
        .collect();
    let text = format!(
        "MCP error -32602: Input validation error: Invalid arguments for tool {tool}: {}",
        lines.join("\n")
    );
    Verdict::Reject(format!(
        "{{\"content\":[{{\"type\":\"text\",\"text\":{}}}],\"isError\":true}}",
        Value::String(text)
    ))
}

#[derive(Debug, Clone, PartialEq)]
enum Seg {
    Key(String),
    Idx(usize),
}

/// SDK `getDotPath` — 첫 칸은 그대로, 그 뒤 수는 `[n]`, 키는 `.k`.
fn dot_path(p: &[Seg]) -> String {
    let mut out = String::new();
    for (i, s) in p.iter().enumerate() {
        match (i, s) {
            (0, Seg::Key(k)) => out.push_str(k),
            (0, Seg::Idx(n)) => out.push_str(&n.to_string()),
            (_, Seg::Key(k)) => {
                out.push('.');
                out.push_str(k);
            }
            (_, Seg::Idx(n)) => out.push_str(&format!("[{n}]")),
        }
    }
    out
}

/// zod 의 결과 상태 — `Aborted` 는 INVALID(형이 틀림), `Dirty` 는 검사만 틀림.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum St {
    Ok,
    Dirty,
    Aborted,
}

fn worst(a: St, b: St) -> St {
    match (a, b) {
        (St::Aborted, _) | (_, St::Aborted) => St::Aborted,
        (St::Dirty, _) | (_, St::Dirty) => St::Dirty,
        _ => St::Ok,
    }
}

/// zod `getParsedType` 의 이름.
fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// JS `String(n)` — 정수만 확정한다.
fn js_num(n: f64) -> Option<String> {
    (n.fract() == 0.0 && n.abs() < 1e15).then(|| format!("{}", n as i64))
}

/// zod `util.joinValues` — 문자열은 `'a'`, 그 밖은 그대로, ` | ` 로 잇는다.
fn join_values(vals: &[Oj]) -> Option<String> {
    let mut out = Vec::new();
    for v in vals {
        out.push(match v {
            Oj::Str(s) => format!("'{s}'"),
            Oj::Num(n) => js_num(*n)?,
            _ => return None,
        });
    }
    Some(out.join(" | "))
}

/// JS 패턴 → Rust 정규식(ASCII `\d`·`\w`, `\/` 는 `/`). 모르는 꼴이면 `None`.
fn pattern(src: &str) -> Option<&'static regex::Regex> {
    static C: std::sync::OnceLock<
        std::sync::Mutex<HashMap<String, Option<&'static regex::Regex>>>,
    > = std::sync::OnceLock::new();
    let mut m = C.get_or_init(Default::default).lock().ok()?;
    *m.entry(src.to_owned()).or_insert_with(|| {
        let r = src
            .replace(r"\/", "/")
            .replace(r"\d", "[0-9]")
            .replace(r"\w", "[A-Za-z0-9_]");
        regex::Regex::new(&r).ok().map(|r| &*Box::leak(Box::new(r)))
    })
}

type Issues = Vec<(Vec<Seg>, String)>;

struct Cx<'a> {
    root: &'a Oj,
    tool: &'a str,
    issues: Issues,
    /// `z.union` 의 이슈 — SDK 는 `safeParseAsync` 로 검사하고, async 의 union 은 갈래를 `Promise.all` 로 돌린 **뒤에** 이슈를 싣는다.
    /// 그래서 동기 이슈(형·길이·범위) 다음에 온다. 둘 이상이면 서로의 순서를 확정하지 않는다(`Unsure`).
    deferred: Vec<Issues>,
    unsure: bool,
}

impl<'a> Cx<'a> {
    fn new(root: &'a Oj, tool: &'a str) -> Self {
        Cx {
            root,
            tool,
            issues: Vec::new(),
            deferred: Vec::new(),
            unsure: false,
        }
    }

    /// zod 가 싣는 순서의 이슈 — 확정하지 못하면 `None`.
    fn finish(self) -> Option<Issues> {
        if self.unsure || self.deferred.len() > 1 {
            return None;
        }
        let mut out = self.issues;
        out.extend(self.deferred.into_iter().flatten());
        Some(out)
    }

    fn resolve(&self, s: &'a Oj) -> Option<&'a Oj> {
        let mut s = s;
        for _ in 0..16 {
            let Some(r) = s.get("$ref").and_then(Oj::str) else {
                return Some(s);
            };
            let mut cur = self.root;
            for seg in r.strip_prefix("#/")?.split('/') {
                cur = match cur {
                    Oj::Obj(_) => cur.get(seg)?,
                    Oj::Arr(a) => a.get(seg.parse::<usize>().ok()?)?,
                    _ => return None,
                };
            }
            s = cur;
        }
        None
    }

    fn issue(&mut self, path: &[Seg], msg: impl Into<String>) {
        self.issues.push((path.to_vec(), msg.into()));
    }

    fn required_or_type(&mut self, path: &[Seg], expected: &str, v: Option<&Value>) -> St {
        match v {
            None => self.issue(path, "Required"),
            Some(v) => self.issue(
                path,
                format!("Expected {expected}, received {}", type_name(v)),
            ),
        }
        St::Aborted
    }

    fn node(&mut self, s0: &'a Oj, v: Option<&Value>, path: &mut Vec<Seg>) -> St {
        let st = self.node_raw(s0, v, path);
        // `.transform()` 은 안쪽이 「더러움」(길이·범위만 틀림)이어도 값을 못 만들어 「중단」으로 끝난다(이슈는 그대로 실린다).
        if st == St::Dirty
            && TRANSFORMS
                .iter()
                .any(|(t, p)| *t == self.tool && *p == dot_path(path))
        {
            return St::Aborted;
        }
        st
    }

    fn node_raw(&mut self, s0: &'a Oj, v: Option<&Value>, path: &mut Vec<Seg>) -> St {
        let Some(s) = self.resolve(s0) else {
            self.unsure = true;
            return St::Ok;
        };
        if let Some(opts) = s.get("anyOf") {
            return self.any_of(opts.arr(), v, path);
        }
        if let Some(c) = s.get("const") {
            let Some(want) = c.js() else {
                self.unsure = true;
                return St::Ok;
            };
            let want_v = serde_json::from_str::<Value>(&want).ok();
            let same = v.is_some_and(|v| Some(v) == want_v.as_ref());
            if !same {
                self.issue(path, format!("Invalid literal value, expected {want}"));
                return St::Aborted;
            }
            return St::Ok;
        }
        if let Some(e) = s.get("enum") {
            let Some(joined) = join_values(e.arr()) else {
                self.unsure = true;
                return St::Ok;
            };
            return match v {
                None => self.required_or_type(path, "", None),
                Some(Value::String(x)) => {
                    if e.arr().iter().any(|o| o.str() == Some(x)) {
                        St::Ok
                    } else {
                        self.issue(
                            path,
                            format!("Invalid enum value. Expected {joined}, received '{x}'"),
                        );
                        St::Aborted
                    }
                }
                Some(other) => {
                    if e.arr().iter().any(|o| !matches!(o, Oj::Str(_))) {
                        self.unsure = true;
                        return St::Ok;
                    }
                    self.issue(
                        path,
                        format!("Expected {joined}, received {}", type_name(other)),
                    );
                    St::Aborted
                }
            };
        }
        let ty = match s.get("type") {
            None => {
                // `{}` — z.unknown()/z.any(): 무엇이든 받는다. 모르는 키만 있으면 확정하지 않는다.
                if let Oj::Obj(o) = s
                    && o.iter().all(|(k, _)| k == "description" || k == "default")
                {
                    return St::Ok;
                }
                self.unsure = true;
                return St::Ok;
            }
            Some(Oj::Str(t)) => t.as_str(),
            Some(_) => {
                self.unsure = true;
                return St::Ok;
            }
        };
        match ty {
            "string" => self.string(s, v, path),
            "integer" | "number" => self.number(s, ty == "integer", v, path),
            "boolean" => match v {
                Some(Value::Bool(_)) => St::Ok,
                _ => self.required_or_type(path, "boolean", v),
            },
            "null" => match v {
                Some(Value::Null) => St::Ok,
                _ => self.required_or_type(path, "null", v),
            },
            "array" => self.array(s, v, path),
            "object" => self.object(s, v, path),
            _ => {
                self.unsure = true;
                St::Ok
            }
        }
    }

    fn string(&mut self, s: &'a Oj, v: Option<&Value>, path: &[Seg]) -> St {
        let Some(Value::String(x)) = v else {
            return self.required_or_type(path, "string", v);
        };
        let len = x.encode_utf16().count() as f64;
        let (min, max) = (
            s.get("minLength").and_then(Oj::num),
            s.get("maxLength").and_then(Oj::num),
        );
        if min.is_some() && min == max {
            // `.length(n)` 과 `.min(n).max(n)` 의 문구가 다르다.
            self.unsure = true;
            return St::Ok;
        }
        let mut st = St::Ok;
        if let Some(m) = min
            && len < m
        {
            self.issue(
                path,
                format!("String must contain at least {} character(s)", m as i64),
            );
            st = St::Dirty;
        }
        if let Some(m) = max
            && len > m
        {
            self.issue(
                path,
                format!("String must contain at most {} character(s)", m as i64),
            );
            st = St::Dirty;
        }
        match s.get("format").and_then(Oj::str) {
            None => {}
            Some("uuid") => {
                if !crate::core::channels::is_uuid(x) {
                    self.issue(path, "Invalid uuid");
                    st = St::Dirty;
                }
            }
            Some("date-time") => match crate::write::zod_datetime_offset(x) {
                Err(()) => {
                    self.issue(path, "Invalid datetime");
                    st = St::Dirty;
                }
                // 시간대가 붙은 값은 `datetime()`(Z 만)과 `datetime({ offset: true })` 가 갈린다 — 스키마로는 모른다.
                Ok(_) if !x.ends_with('Z') => self.unsure = true,
                Ok(_) => {}
            },
            // `url()` 은 JS `new URL` 판정 + 숨은 refine(https 만 등)이 붙는다.
            Some(_) => self.unsure = true,
        }
        if let Some(p) = s.get("pattern").and_then(Oj::str) {
            match pattern(p) {
                None => self.unsure = true,
                Some(re) if !re.is_match(x) => {
                    let msg = PATTERN_MESSAGES
                        .iter()
                        .find(|(src, _)| *src == p)
                        .map_or("Invalid", |(_, m)| m);
                    self.issue(path, msg);
                    st = St::Dirty;
                }
                Some(_) => {}
            }
        }
        if TZ_CHECKS
            .iter()
            .any(|(t, p)| *t == self.tool && *p == dot_path(path))
            && crate::core::automation_time::parse_tz(x).is_none()
        {
            // `.refine(isTimeZone, 'unknown time zone')` — refine 은 길이 검사 뒤에 돌고, 길이만 틀린 값(더러움)에도 돈다.
            self.issue(path, "unknown time zone");
            st = St::Dirty;
        }
        st
    }

    fn number(&mut self, s: &'a Oj, int: bool, v: Option<&Value>, path: &[Seg]) -> St {
        let Some(n) = v
            .and_then(Value::as_f64)
            .filter(|_| v.is_some_and(Value::is_number))
        else {
            return self.required_or_type(path, "number", v);
        };
        let mut st = St::Ok;
        if int && n.fract() != 0.0 {
            self.issue(path, "Expected integer, received float");
            st = St::Dirty;
        }
        let bound = |k: &str| s.get(k).and_then(Oj::num);
        let mut cmp = |cx: &mut Self, b: Option<f64>, bad: bool, words: &str| {
            if let Some(b) = b
                && bad
            {
                match js_num(b) {
                    Some(t) => cx.issue(path, format!("Number must be {words} {t}")),
                    None => cx.unsure = true,
                }
                st = St::Dirty;
            }
        };
        let (lo, xlo, hi, xhi) = (
            bound("minimum"),
            bound("exclusiveMinimum"),
            bound("maximum"),
            bound("exclusiveMaximum"),
        );
        cmp(
            self,
            lo,
            lo.is_some_and(|b| n < b),
            "greater than or equal to",
        );
        cmp(self, xlo, xlo.is_some_and(|b| n <= b), "greater than");
        cmp(self, hi, hi.is_some_and(|b| n > b), "less than or equal to");
        cmp(self, xhi, xhi.is_some_and(|b| n >= b), "less than");
        st
    }

    fn array(&mut self, s: &'a Oj, v: Option<&Value>, path: &mut Vec<Seg>) -> St {
        let Some(Value::Array(a)) = v else {
            return self.required_or_type(path, "array", v);
        };
        let (min, max) = (
            s.get("minItems").and_then(Oj::num),
            s.get("maxItems").and_then(Oj::num),
        );
        if min.is_some() && min == max {
            self.unsure = true;
            return St::Ok;
        }
        let mut st = St::Ok;
        let n = a.len() as f64;
        if let Some(m) = min
            && n < m
        {
            self.issue(
                path,
                format!("Array must contain at least {} element(s)", m as i64),
            );
            st = St::Dirty;
        }
        if let Some(m) = max
            && n > m
        {
            self.issue(
                path,
                format!("Array must contain at most {} element(s)", m as i64),
            );
            st = St::Dirty;
        }
        let item = s.get("items");
        for (i, x) in a.iter().enumerate() {
            path.push(Seg::Idx(i));
            let r = match item {
                Some(it) => self.node(it, Some(x), path),
                None => St::Ok,
            };
            path.pop();
            st = worst(st, r);
        }
        st
    }

    fn object(&mut self, s: &'a Oj, v: Option<&Value>, path: &mut Vec<Seg>) -> St {
        let Some(Value::Object(o)) = v else {
            return self.required_or_type(path, "object", v);
        };
        let extra = s
            .get("additionalProperties")
            .filter(|a| matches!(a, Oj::Obj(_)));
        let props = s.get("properties");
        let mut st = St::Ok;
        match (props, extra) {
            (Some(Oj::Obj(props)), None) => {
                let required: Vec<&str> = s
                    .get("required")
                    .map(Oj::arr)
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(Oj::str)
                    .collect();
                for (k, ps) in props {
                    let x = o.get(k);
                    if x.is_none() && !required.contains(&k.as_str()) {
                        continue;
                    }
                    path.push(Seg::Key(k.clone()));
                    let r = self.node(ps, x, path);
                    path.pop();
                    st = worst(st, r);
                }
            }
            (None, Some(val)) => {
                // z.record — 입력 키 순서로 돈다. serde_json 은 키를 정렬하므로 이슈가 둘 이상 나면 순서를 확정하지 못한다.
                let before = self.issues.len();
                let mut bad_keys = 0;
                for (k, x) in o {
                    let n = self.issues.len();
                    path.push(Seg::Key(k.clone()));
                    let r = self.node(val, Some(x), path);
                    path.pop();
                    if self.issues.len() > n {
                        bad_keys += 1;
                    }
                    st = worst(st, r);
                }
                if bad_keys > 1 && self.issues.len() > before {
                    self.unsure = true;
                }
            }
            (None, None) => {}
            _ => self.unsure = true,
        }
        st
    }

    /// `anyOf` — `[X, null]` 은 `.nullable()`, 모든 갈래가 같은 키의 상수를 가진 객체면 `z.discriminatedUnion`, 그 밖은 `z.union`.
    fn any_of(&mut self, opts: &'a [Oj], v: Option<&Value>, path: &mut Vec<Seg>) -> St {
        let resolved: Vec<&'a Oj> = opts.iter().filter_map(|o| self.resolve(o)).collect();
        if resolved.len() != opts.len() || opts.is_empty() {
            self.unsure = true;
            return St::Ok;
        }
        let is_null = |o: &Oj| o.get("type").and_then(Oj::str) == Some("null");
        let others: Vec<&'a Oj> = resolved.iter().copied().filter(|o| !is_null(o)).collect();
        if others.len() == 1 && resolved.len() == 2 {
            if matches!(v, Some(Value::Null)) {
                return St::Ok;
            }
            return self.node(others[0], v, path);
        }
        if let Some(key) = discriminator(&resolved) {
            let Some(Value::Object(o)) = v else {
                return self.required_or_type(path, "object", v);
            };
            let pick = resolved.iter().find(|opt| {
                let c = opt
                    .get("properties")
                    .and_then(|p| p.get(key))
                    .and_then(|p| p.get("const"));
                matches!((c, o.get(key)), (Some(Oj::Str(c)), Some(Value::String(x))) if c == x)
            });
            return match pick {
                Some(opt) => self.node(opt, v, path),
                None => {
                    let consts: Vec<Oj> = resolved
                        .iter()
                        .filter_map(|opt| opt.get("properties")?.get(key)?.get("const").cloned())
                        .collect();
                    let Some(j) = join_values(&consts) else {
                        self.unsure = true;
                        return St::Ok;
                    };
                    path.push(Seg::Key(key.to_owned()));
                    self.issue(path, format!("Invalid discriminator value. Expected {j}"));
                    path.pop();
                    St::Aborted
                }
            };
        }
        // z.union — 하나라도 통과면 통과, 아니면 처음 「더러움」 갈래의 이슈, 그것도 없으면 `Invalid input`.
        let mut dirty: Option<Issues> = None;
        for opt in resolved {
            let mut sub = Cx::new(self.root, self.tool);
            let r = sub.node(opt, v, path);
            let Some(iss) = sub.finish() else {
                self.unsure = true;
                return St::Ok;
            };
            match r {
                St::Ok => return St::Ok,
                St::Dirty if dirty.is_none() => dirty = Some(iss),
                _ => {}
            }
        }
        match dirty {
            Some(iss) => {
                self.deferred.push(iss);
                St::Dirty
            }
            None => {
                self.deferred
                    .push(vec![(path.clone(), "Invalid input".into())]);
                St::Aborted
            }
        }
    }
}

/// 모든 갈래가 객체이고 같은 키에 문자열 상수를 가지면 그 키(서로 다른 값일 때만).
fn discriminator<'a>(opts: &[&'a Oj]) -> Option<&'a str> {
    let first = opts.first()?.get("properties")?;
    let Oj::Obj(props) = first else { return None };
    'keys: for (k, _) in props {
        let mut seen: Vec<&str> = Vec::new();
        for o in opts {
            if o.get("type").and_then(Oj::str) != Some("object") {
                return None;
            }
            match o
                .get("properties")
                .and_then(|p| p.get(k))
                .and_then(|p| p.get("const"))
                .and_then(Oj::str)
            {
                Some(c) if !seen.contains(&c) => seen.push(c),
                _ => continue 'keys,
            }
        }
        return Some(k.as_str());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TS(실제 zod 스키마 + SDK 함수)가 구운 꼴마다 Rust 가 같은 글자를 내거나(Reject) 모른다고(Unsure) 하는지 본다.
    /// 다른 글자로 거절하거나, TS 가 받는 것을 거절하면 실패다. 남는 꼴(TS 로 가는 것)의 수를 찍는다.
    #[test]
    fn matches_ts_zod_golden() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../golden/mcp_zod_cases.json")).unwrap();
        let (mut same, mut pass_ok, mut unsure, mut ts_only) = (0, 0, 0, 0);
        let mut left: std::collections::BTreeMap<String, usize> = Default::default();
        let mut bad = Vec::new();
        for c in &cases {
            let tool = c["tool"].as_str().unwrap();
            let want = c["text"].as_str();
            let got = check(tool, &c["args"]);
            match (&got, want) {
                (Verdict::Reject(r), Some(w)) => {
                    let t: Value = serde_json::from_str(r).unwrap();
                    if t["content"][0]["text"].as_str() == Some(w) && t["isError"] == true {
                        same += 1;
                    } else {
                        bad.push(format!(
                            "{tool} {}\n  rust: {}\n  ts:   {w}",
                            c["args"], t["content"][0]["text"]
                        ));
                    }
                }
                (Verdict::Reject(r), None) => bad.push(format!(
                    "{tool} {} — TS 는 받는데 Rust 가 거절: {r}",
                    c["args"]
                )),
                (Verdict::Pass, None) => pass_ok += 1,
                (Verdict::Unsure, _) => {
                    unsure += 1;
                    *left.entry(format!("{tool} unsure")).or_default() += 1;
                }
                (Verdict::Pass, Some(w)) => {
                    ts_only += 1;
                    *left
                        .entry(format!(
                            "{tool} pass-but-ts-rejects: {}",
                            w.rsplit(": ").next().unwrap_or(w)
                        ))
                        .or_default() += 1;
                }
            }
        }
        eprintln!(
            "zod gate: same={same} pass={pass_ok} unsure={unsure} pass-but-ts-rejects={ts_only} of {}",
            cases.len()
        );
        for (k, n) in &left {
            eprintln!("  {n:4} {k}");
        }
        assert!(
            bad.is_empty(),
            "{} 다른 글자:\n{}",
            bad.len(),
            bad.iter().take(30).cloned().collect::<Vec<_>>().join("\n")
        );
        // `{}`(빈 인자)는 모든 도구에서 확정해야 한다 — 0.4.879 셈에서 TS 로 빠진 꼴(memory.set).
        for c in cases.iter().filter(|c| c["args"] == serde_json::json!({})) {
            let tool = c["tool"].as_str().unwrap();
            let got = check(tool, &c["args"]);
            match c["text"].as_str() {
                Some(_) => assert!(matches!(got, Verdict::Reject(_)), "{tool} {{}} → {got:?}"),
                None => assert_eq!(got, Verdict::Pass, "{tool} {{}}"),
            }
        }
    }

    /// bus-e2e(`rustFrontDb.test.ts`)가 도구마다 고르는 꼴 — 첫 거절 꼴(인자 글자 400자 미만, `delegation.close` 뺌)을 Rust 가 확정해야 한다.
    #[test]
    fn bus_e2e_picks_are_definite() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../golden/mcp_zod_cases.json")).unwrap();
        let mut seen = std::collections::HashSet::new();
        for c in &cases {
            let tool = c["tool"].as_str().unwrap();
            if c["text"].is_null()
                || tool == "delegation.close"
                || seen.contains(tool)
                || c["args"].to_string().len() >= 400
            {
                continue;
            }
            seen.insert(tool.to_owned());
            assert!(
                matches!(check(tool, &c["args"]), Verdict::Reject(_)),
                "{tool} {}",
                c["args"]
            );
        }
        assert!(seen.len() > 50, "{}", seen.len());
    }

    #[test]
    fn memory_set_empty_object_is_sdk_text() {
        let Verdict::Reject(r) = check("memory.set", &serde_json::json!({})) else {
            panic!()
        };
        assert_eq!(
            r,
            r#"{"content":[{"type":"text","text":"MCP error -32602: Input validation error: Invalid arguments for tool memory.set: Required at slug\nRequired at value"}],"isError":true}"#
        );
        assert_eq!(check("memory.set", &Value::Null), Verdict::Unsure);
        assert_eq!(
            check("no.such.tool", &serde_json::json!({})),
            Verdict::Unsure
        );
    }
}
