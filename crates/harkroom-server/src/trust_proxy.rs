//! 클라이언트 주소(감사 `ip`) — TS 서버의 `TRUST_PROXY`(`config.ts::parseTrustProxy`)와 fastify `req.ip`(proxy-addr)를 옮긴다.
//!
//! 값의 꼴은 TS 와 같다: 빈 값·`0`·`false` = 안 믿음(소켓 주소) · `1`·`true` = 전부 믿음(비권장, `X-Forwarded-For` 맨 왼쪽) ·
//! `2`~`16` = 소켓에서부터 믿을 홉 수 · 쉼표로 이은 IP/CIDR 목록 = 그 대역의 프록시만 믿음. 모르는 값이면 **기동을 멈춘다**(TS 와 같은 까닭 —
//! 조용히 끄면 모두가 프록시 주소 하나로 묶이고, 조용히 켜면 위조가 통한다).
//!
//! **홉 수는 앞단 자기 소켓에서부터 센다.** TS 는 앞단 뒤에 있어 같은 배포에서도 한 홉을 더 센다 — 홉 수로 쓰면 앞단 값은 TS 값보다
//! 하나 작아야 한다. CIDR 목록은 홉과 상관없이 같은 값을 쓰면 된다(운영은 이 꼴이다).
//!
//! 판정(proxy-addr `alladdrs`): 주소 줄 = [소켓, …XFF 를 오른쪽부터]. 앞에서부터 믿는 동안 넘어가고, 처음으로 못 믿는 주소에서 멈춰 그 주소를
//! 쓴다. 끝까지 믿으면 맨 마지막(XFF 맨 왼쪽)이다. IP 가 아닌 글자는 믿지 않는다(그 글자 자체가 답이 된다 — TS 도 같다).
use std::net::IpAddr;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum TrustProxy {
    #[default]
    None,
    All,
    Hops(usize),
    Cidrs(Vec<(IpAddr, u8)>),
}

/// TS `parseTrustProxy` 와 같은 규칙.
pub fn parse(raw: Option<&str>) -> Result<TrustProxy, String> {
    let v = raw.unwrap_or("").trim();
    let lower = v.to_ascii_lowercase();
    if v.is_empty() || v == "0" || lower == "false" {
        return Ok(TrustProxy::None);
    }
    if v == "1" || lower == "true" {
        return Ok(TrustProxy::All);
    }
    let hops = v.bytes().all(|b| b.is_ascii_digit());
    if hops {
        if let Ok(n) = v.parse::<usize>()
            && (2..=16).contains(&n)
        {
            return Ok(TrustProxy::Hops(n));
        }
    } else {
        let list: Vec<&str> = v
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        let parsed: Option<Vec<(IpAddr, u8)>> = list.iter().map(|s| cidr(s)).collect();
        if let Some(p) = parsed.filter(|p| !p.is_empty()) {
            return Ok(TrustProxy::Cidrs(p));
        }
    }
    Err(format!(
        "TRUST_PROXY={v:?} is not understood — use a hop count of 2 or more, a comma-separated list of proxy IPs/CIDRs, or 0 to disable"
    ))
}

fn cidr(s: &str) -> Option<(IpAddr, u8)> {
    let (addr, bits) = match s.split_once('/') {
        Some((a, b)) => (a, Some(b)),
        None => (s, None),
    };
    let ip: IpAddr = addr.parse().ok()?;
    let max = if ip.is_ipv4() { 32 } else { 128 };
    let bits = match bits {
        None => max,
        Some(b) if !b.is_empty() && b.len() <= 3 && b.bytes().all(|c| c.is_ascii_digit()) => {
            b.parse::<u8>().ok().filter(|n| *n <= max)?
        }
        Some(_) => return None,
    };
    Some((ip, bits))
}

/// proxy-addr `forwarded::parse` — 뒤에서부터 쉼표로 나누고, 토큰 둘레 공백은 버린다(토큰 안의 공백은 남는다).
pub fn parse_xff(header: &str) -> Vec<&str> {
    let b = header.as_bytes();
    let (mut start, mut end) = (b.len(), b.len());
    let mut list = vec![];
    for i in (0..b.len()).rev() {
        match b[i] {
            b' ' => {
                if start == end {
                    start = i;
                    end = i;
                }
            }
            b',' => {
                if start != end {
                    list.push(&header[start..end]);
                }
                start = i;
                end = i;
            }
            _ => start = i,
        }
    }
    if start != end {
        list.push(&header[start..end]);
    }
    list
}

fn in_subnet(ip: IpAddr, (net, bits): (IpAddr, u8)) -> bool {
    // IPv4 대역에는 IPv4-mapped IPv6 도 맞춰 본다(proxy-addr `trustMulti`).
    let ip = match (ip, net) {
        (IpAddr::V6(v6), IpAddr::V4(_)) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => return false,
        },
        (IpAddr::V4(v4), IpAddr::V6(_)) => IpAddr::V6(v4.to_ipv6_mapped()),
        _ => ip,
    };
    match (ip, net) {
        (IpAddr::V4(a), IpAddr::V4(n)) => {
            let m = if bits == 0 {
                0
            } else {
                u32::MAX << (32 - bits)
            };
            u32::from(a) & m == u32::from(n) & m
        }
        (IpAddr::V6(a), IpAddr::V6(n)) => {
            let m = if bits == 0 {
                0
            } else {
                u128::MAX << (128 - bits)
            };
            u128::from(a) & m == u128::from(n) & m
        }
        _ => false,
    }
}

impl TrustProxy {
    fn trusts(&self, addr: &str, hop: usize) -> bool {
        match self {
            TrustProxy::None => false,
            TrustProxy::All => true,
            TrustProxy::Hops(n) => hop < *n,
            TrustProxy::Cidrs(list) => addr
                .parse::<IpAddr>()
                .is_ok_and(|ip| list.iter().any(|c| in_subnet(ip, *c))),
        }
    }

    /// fastify `req.ip` — 소켓 주소 `peer` 와 들어온 `X-Forwarded-For`(여러 줄이면 `, ` 로 이은 것).
    pub fn client_ip(&self, peer: IpAddr, xff: Option<&str>) -> String {
        let socket = peer.to_string();
        if *self == TrustProxy::None {
            return socket;
        }
        let mut addrs: Vec<&str> = vec![&socket];
        addrs.extend(parse_xff(xff.unwrap_or("")));
        let mut last = addrs.len() - 1;
        for (i, a) in addrs.iter().enumerate().take(addrs.len() - 1) {
            if !self.trusts(a, i) {
                last = i;
                break;
            }
        }
        addrs[last].to_string()
    }
}

/// 요청의 클라이언트 주소. `ConnectInfo` 가 없으면(시험 라우터 등) `None`.
pub fn request_ip(parts: &axum::http::request::Parts, tp: &TrustProxy) -> Option<String> {
    let peer = parts
        .extensions
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()?
        .0
        .ip();
    let xff: Vec<&str> = parts
        .headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect();
    let joined = xff.join(", ");
    Some(tp.client_ip(peer, (!xff.is_empty()).then_some(joined.as_str())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn parse_follows_ts() {
        assert_eq!(parse(None), Ok(TrustProxy::None));
        assert_eq!(parse(Some(" 0 ")), Ok(TrustProxy::None));
        assert_eq!(parse(Some("FALSE")), Ok(TrustProxy::None));
        assert_eq!(parse(Some("1")), Ok(TrustProxy::All));
        assert_eq!(parse(Some("True")), Ok(TrustProxy::All));
        assert_eq!(parse(Some("2")), Ok(TrustProxy::Hops(2)));
        assert_eq!(parse(Some("16")), Ok(TrustProxy::Hops(16)));
        assert!(parse(Some("17")).is_err());
        assert_eq!(
            parse(Some("10.0.0.0/8, ::1")),
            Ok(TrustProxy::Cidrs(vec![
                (ip("10.0.0.0"), 8),
                (ip("::1"), 128)
            ]))
        );
        assert!(parse(Some("10.0.0.0/33")).is_err());
        assert!(parse(Some("nope")).is_err());
        assert!(parse(Some("10.0.0.1,nope")).is_err());
    }

    #[test]
    fn xff_tokens_like_forwarded() {
        assert_eq!(parse_xff("a, b,c"), vec!["c", "b", "a"]);
        assert_eq!(parse_xff(" a ,, b "), vec!["b", "a"]);
        assert_eq!(parse_xff(""), Vec::<&str>::new());
    }

    #[test]
    fn client_ip_walks_like_proxy_addr() {
        let peer = ip("10.244.1.5");
        let xff = Some("6.6.6.6, 203.0.113.7");
        assert_eq!(TrustProxy::None.client_ip(peer, xff), "10.244.1.5");
        assert_eq!(
            TrustProxy::All.client_ip(peer, xff),
            "6.6.6.6",
            "전부 믿으면 맨 왼쪽(위조 가능)"
        );
        assert_eq!(TrustProxy::Hops(2).client_ip(peer, xff), "6.6.6.6");
        assert_eq!(
            TrustProxy::Hops(2).client_ip(peer, Some("203.0.113.7")),
            "203.0.113.7"
        );
        let pods = parse(Some("10.244.0.0/16")).unwrap();
        assert_eq!(
            pods.client_ip(peer, xff),
            "203.0.113.7",
            "CF 가 덧붙인 값에서 멈춘다"
        );
        assert_eq!(pods.client_ip(peer, Some("6.6.6.6, 10.244.9.9")), "6.6.6.6");
        assert_eq!(
            pods.client_ip(ip("8.8.8.8"), xff),
            "8.8.8.8",
            "소켓이 대역 밖이면 XFF 를 보지 않는다"
        );
        assert_eq!(
            pods.client_ip(peer, Some("garbage")),
            "garbage",
            "IP 가 아닌 글자는 믿지 않고 그대로 답이 된다"
        );
        assert_eq!(pods.client_ip(peer, None), "10.244.1.5");
        assert_eq!(
            pods.client_ip(ip("::ffff:10.244.1.5"), xff),
            "203.0.113.7",
            "IPv4-mapped 도 맞춘다"
        );
    }
}
