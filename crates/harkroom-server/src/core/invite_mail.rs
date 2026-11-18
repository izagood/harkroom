//! 초대 메일(149) — TS `services/mail/mailer.ts`·`inviteMail.ts` 를 옮긴다.
//!
//! - env: `HARKROOM_SMTP_HOST`·`HARKROOM_SMTP_PORT`(기본 587)·`HARKROOM_SMTP_USER`·`HARKROOM_SMTP_PASSWORD`·
//!   `HARKROOM_MAIL_FROM`·`HARKROOM_PUBLIC_URL`. SMTP·발신 칸이 하나도 없으면 메일을 끈다(None). 일부만 있으면 기동 오류.
//! - 465 는 처음부터 TLS, 그 밖은 STARTTLS 를 요구한다. 시간 제한 15초.
//! - 본문은 text/plain 만. 토큰은 링크의 `#` 뒤에 싣는다.
use lettre::message::header::ContentType;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailConfig {
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub password: Option<String>,
    pub from: String,
    pub public_url: String,
}

const REQUIRED: [&str; 3] = [
    "HARKROOM_SMTP_HOST",
    "HARKROOM_MAIL_FROM",
    "HARKROOM_PUBLIC_URL",
];
const MAIL_INTENT: [&str; 5] = [
    "HARKROOM_SMTP_HOST",
    "HARKROOM_MAIL_FROM",
    "HARKROOM_SMTP_PORT",
    "HARKROOM_SMTP_USER",
    "HARKROOM_SMTP_PASSWORD",
];

/// TS `loadMailConfig`. 오류 문구는 TS 와 같다(값이 아니라 이름만 싣는다).
pub fn load_mail_config(
    env: impl Fn(&str) -> Option<String>,
) -> Result<Option<MailConfig>, String> {
    let set = |n: &str| env(n).is_some_and(|v| !v.trim().is_empty());
    if !MAIL_INTENT.iter().any(|n| set(n)) {
        return Ok(None);
    }
    let missing: Vec<&str> = REQUIRED.iter().copied().filter(|n| !set(n)).collect();
    if !missing.is_empty() {
        return Err(format!(
            "mail: {} is missing (set {} to send invite mail, or none of HARKROOM_SMTP_*/HARKROOM_MAIL_FROM)",
            missing.join(", "),
            REQUIRED.join(", ")
        ));
    }
    if set("HARKROOM_SMTP_USER") != set("HARKROOM_SMTP_PASSWORD") {
        return Err(
            "mail: set both HARKROOM_SMTP_USER and HARKROOM_SMTP_PASSWORD, or neither".into(),
        );
    }
    let port = if set("HARKROOM_SMTP_PORT") {
        match env("HARKROOM_SMTP_PORT")
            .unwrap_or_default()
            .trim()
            .parse::<u16>()
        {
            Ok(p) if p >= 1 => p,
            _ => return Err("mail: HARKROOM_SMTP_PORT is not a port number".into()),
        }
    } else {
        587
    };
    let public_url = env("HARKROOM_PUBLIC_URL")
        .unwrap_or_default()
        .trim()
        .trim_end_matches('/')
        .to_string();
    let parsed = url::Url::parse(&public_url)
        .map_err(|_| "mail: HARKROOM_PUBLIC_URL is not a URL".to_string())?;
    let scheme = parsed.scheme();
    if scheme != "https" && scheme != "http" {
        return Err("mail: HARKROOM_PUBLIC_URL must be http(s)".into());
    }
    let host = parsed.host_str().unwrap_or("");
    if scheme == "http" && !matches!(host, "localhost" | "127.0.0.1" | "[::1]") {
        return Err(
            "mail: HARKROOM_PUBLIC_URL must be https (http is allowed only for localhost)".into(),
        );
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("mail: HARKROOM_PUBLIC_URL must not have a query or fragment".into());
    }
    Ok(Some(MailConfig {
        host: env("HARKROOM_SMTP_HOST")
            .unwrap_or_default()
            .trim()
            .to_string(),
        port,
        user: set("HARKROOM_SMTP_USER").then(|| {
            env("HARKROOM_SMTP_USER")
                .unwrap_or_default()
                .trim()
                .to_string()
        }),
        password: set("HARKROOM_SMTP_PASSWORD")
            .then(|| env("HARKROOM_SMTP_PASSWORD").unwrap_or_default()),
        from: env("HARKROOM_MAIL_FROM")
            .unwrap_or_default()
            .trim()
            .to_string(),
        public_url,
    }))
}

/// 메일 한 통(글만).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailMessage {
    pub to: String,
    pub subject: String,
    pub text: String,
}

/// TS `inviteMail`. `expires_at` 은 ISO 문자열(앞 10자 = UTC 날짜).
pub fn invite_mail(
    to: &str,
    token: &str,
    public_url: &str,
    inviter_handle: &str,
    expires_at: &str,
    ko: bool,
) -> MailMessage {
    let link = format!("{public_url}/join#{token}");
    let until = expires_at.get(..10).unwrap_or(expires_at);
    let (subject, lines): (&str, Vec<String>) = if ko {
        (
            "Harkroom 워크스페이스 초대",
            vec![
                format!("@{inviter_handle} 님이 Harkroom 워크스페이스에 초대했습니다."),
                String::new(),
                format!("가입 안내: {link}"),
                String::new(),
                "링크가 열리지 않으면 Harkroom 앱의 「가입」 화면에 아래 두 값을 넣으세요.".into(),
                format!("서버 주소: {public_url}"),
                format!("초대 토큰: {token}"),
                String::new(),
                format!("이 초대는 {until}(UTC)까지 한 번만 쓸 수 있습니다."),
                "초대받을 일이 없다면 이 메일을 무시하세요.".into(),
            ],
        )
    } else {
        (
            "You are invited to a Harkroom workspace",
            vec![
                format!("@{inviter_handle} invited you to a Harkroom workspace."),
                String::new(),
                format!("Join: {link}"),
                String::new(),
                "If the link does not open, enter these two values on the Sign up screen of the Harkroom app.".into(),
                format!("Server address: {public_url}"),
                format!("Invite token: {token}"),
                String::new(),
                format!("This invite can be used once, until {until} (UTC)."),
                "If you were not expecting this, you can ignore this email.".into(),
            ],
        )
    };
    MailMessage {
        to: to.to_string(),
        subject: subject.to_string(),
        text: lines.join("\n"),
    }
}

/// lettre 메시지로 짓는다. 주소가 틀리면 오류 코드만 돌려준다.
pub fn build_message(from: &str, msg: &MailMessage) -> Result<Message, &'static str> {
    Message::builder()
        .from(from.parse().map_err(|_| "EENVELOPE")?)
        .to(msg.to.parse().map_err(|_| "EENVELOPE")?)
        .subject(msg.subject.clone())
        .header(ContentType::TEXT_PLAIN)
        .body(msg.text.clone())
        .map_err(|_| "EMESSAGE")
}

/// 메일 보내는 쪽. 시험은 `Disabled`·직접 짓기로 한다.
#[derive(Clone)]
pub struct Mailer {
    pub public_url: String,
    from: String,
    transport: AsyncSmtpTransport<Tokio1Executor>,
}

impl Mailer {
    /// TS `createSmtpTransport`. 465 는 implicit TLS, 그 밖은 STARTTLS 필수(`requireTLS`).
    pub fn new(cfg: &MailConfig) -> Result<Self, String> {
        let b = if cfg.port == 465 {
            AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host)
        } else {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host)
        }
        .map_err(|_| "mail: SMTP TLS setup failed".to_string())?;
        let mut b = b.port(cfg.port).timeout(Some(Duration::from_secs(15)));
        if let (Some(u), Some(p)) = (&cfg.user, &cfg.password) {
            b = b.credentials(Credentials::new(u.clone(), p.clone()));
        }
        Ok(Self {
            public_url: cfg.public_url.clone(),
            from: cfg.from.clone(),
            transport: b.build(),
        })
    }

    /// 보낸다. 실패하면 **오류 종류만** 돌려준다(SMTP 응답 글에는 받는 사람 주소가 섞이곤 한다).
    pub async fn send(&self, msg: &MailMessage) -> Result<(), String> {
        let m = build_message(&self.from, msg).map_err(str::to_string)?;
        self.transport.send(m).await.map(|_| ()).map_err(|e| {
            let code = e.status().map(|c| c.to_string());
            match code {
                Some(c) => format!("responseCode={c}"),
                None if e.is_timeout() => "ETIMEDOUT".into(),
                None if e.is_tls() => "ETLS".into(),
                None => "ESMTP".into(),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(m: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = m
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn config_off_when_nothing_set() {
        assert_eq!(
            load_mail_config(env(&[("HARKROOM_PUBLIC_URL", "http://x")])),
            Ok(None)
        );
    }

    #[test]
    fn config_errors_mirror_ts() {
        let e = load_mail_config(env(&[("HARKROOM_SMTP_HOST", "smtp.example.com")])).unwrap_err();
        assert!(e.starts_with("mail: HARKROOM_MAIL_FROM, HARKROOM_PUBLIC_URL is missing"));
        let base = [
            ("HARKROOM_SMTP_HOST", "smtp.example.com"),
            ("HARKROOM_MAIL_FROM", "noreply@example.com"),
            ("HARKROOM_PUBLIC_URL", "https://h.example.com/"),
        ];
        let c = load_mail_config(env(&base)).unwrap().unwrap();
        assert_eq!(c.port, 587);
        assert_eq!(c.public_url, "https://h.example.com");
        let mut v = base.to_vec();
        v.push(("HARKROOM_SMTP_USER", "u"));
        assert!(load_mail_config(env(&v)).unwrap_err().contains("both"));
        let mut v = base.to_vec();
        v.push(("HARKROOM_SMTP_PORT", "70000"));
        assert!(
            load_mail_config(env(&v))
                .unwrap_err()
                .contains("port number")
        );
        let mut v = base.to_vec();
        v[2] = ("HARKROOM_PUBLIC_URL", "http://h.example.com");
        assert!(
            load_mail_config(env(&v))
                .unwrap_err()
                .contains("must be https")
        );
        v[2] = ("HARKROOM_PUBLIC_URL", "http://localhost:3000");
        assert!(load_mail_config(env(&v)).is_ok());
        v[2] = ("HARKROOM_PUBLIC_URL", "https://h.example.com/?a=1");
        assert!(load_mail_config(env(&v)).unwrap_err().contains("query"));
    }

    #[test]
    fn invite_mail_en_and_ko() {
        let m = invite_mail(
            "a@b.c",
            "hrki_T",
            "https://h.example.com",
            "alice",
            "2026-11-25T01:02:03.000Z",
            false,
        );
        assert_eq!(m.subject, "You are invited to a Harkroom workspace");
        assert!(m.text.starts_with("@alice invited you to a Harkroom workspace.\n\nJoin: https://h.example.com/join#hrki_T\n"));
        assert!(m.text.contains("Invite token: hrki_T"));
        assert!(m.text.ends_with("This invite can be used once, until 2026-11-25 (UTC).\nIf you were not expecting this, you can ignore this email."));
        let k = invite_mail(
            "a@b.c",
            "hrki_T",
            "https://h.example.com",
            "alice",
            "2026-11-25T01:02:03.000Z",
            true,
        );
        assert_eq!(k.subject, "Harkroom 워크스페이스 초대");
        assert!(
            k.text
                .contains("가입 안내: https://h.example.com/join#hrki_T")
        );
        assert!(k.text.contains("이 초대는 2026-11-25(UTC)까지"));
    }

    #[test]
    fn message_headers_and_body() {
        let m = invite_mail(
            "a@b.c",
            "hrki_T",
            "https://h.example.com",
            "alice",
            "2026-11-25T01:02:03.000Z",
            true,
        );
        let msg = build_message("Harkroom <noreply@example.com>", &m).unwrap();
        let raw = String::from_utf8(msg.formatted()).unwrap();
        assert!(raw.contains("From: Harkroom <noreply@example.com>\r\n"));
        assert!(raw.contains("To: a@b.c\r\n"));
        assert!(raw.contains("Subject: Harkroom =?utf-8?b?"), "{raw}");
        assert!(raw.contains("Content-Type: text/plain; charset=utf-8\r\n"));
        assert_eq!(msg.envelope().to()[0].to_string(), "a@b.c");
        let en = invite_mail(
            "a@b.c",
            "hrki_T",
            "https://h.example.com",
            "alice",
            "2026-11-25",
            false,
        );
        let raw = String::from_utf8(
            build_message("noreply@example.com", &en)
                .unwrap()
                .formatted(),
        )
        .unwrap();
        assert!(raw.contains("Subject: You are invited to a Harkroom workspace\r\n"));
        assert!(raw.contains("Join: https://h.example.com/join#hrki_T"));
        assert!(
            build_message(
                "noreply@example.com",
                &MailMessage {
                    to: "nope".into(),
                    subject: "s".into(),
                    text: "t".into()
                }
            )
            .is_err()
        );
    }
}
