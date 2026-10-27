import { createTransport } from 'nodemailer';

/**
 * 메일 한 통. 본문은 **글(text/plain)만** 보낸다 — HTML 을 만들지 않으면 받는 사람 이름·handle 이 섞여도
 * 메일 안에서 마크업이 될 길이 없다.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  send(msg: MailMessage): Promise<void>;
}

/** 메일 설정. `publicUrl` 은 메일 본문의 서버 주소·안내 링크가 된다(뒤 `/` 없음). */
export interface MailConfig {
  host: string;
  port: number;
  user: string | null;
  password: string | null;
  from: string;
  publicUrl: string;
}

export interface Mailer {
  transport: MailTransport;
  publicUrl: string;
}

const REQUIRED = ['HARKROOM_SMTP_HOST', 'HARKROOM_MAIL_FROM', 'HARKROOM_PUBLIC_URL'] as const;
const ALL = [...REQUIRED, 'HARKROOM_SMTP_PORT', 'HARKROOM_SMTP_USER', 'HARKROOM_SMTP_PASSWORD'] as const;

/**
 * env 에서 메일 설정을 읽는다. **하나도 없으면 null**(메일을 끈다 — 초대는 지금처럼 화면에서 건넨다).
 * 일부만 있으면 기동을 멈춘다 — APNS 와 같은 규칙이다("켰다고 생각했는데 조용히 꺼져 있다"가 가장 찾기 어렵다).
 * 오류 문구에는 값이 아니라 **이름**만 싣는다(비밀번호가 로그에 남지 않게).
 */
export function loadMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig | null {
  const set = (n: string) => (env[n] ?? '').trim() !== '';
  if (!ALL.some(set)) return null;
  const missing = REQUIRED.filter((n) => !set(n));
  if (missing.length) throw new Error(`mail: ${missing.join(', ')} is missing (set ${REQUIRED.join(', ')} to send invite mail, or none of HARKROOM_SMTP_*/HARKROOM_MAIL_FROM/HARKROOM_PUBLIC_URL)`);
  if (set('HARKROOM_SMTP_USER') !== set('HARKROOM_SMTP_PASSWORD')) {
    throw new Error('mail: set both HARKROOM_SMTP_USER and HARKROOM_SMTP_PASSWORD, or neither');
  }
  const port = set('HARKROOM_SMTP_PORT') ? Number(env.HARKROOM_SMTP_PORT!.trim()) : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('mail: HARKROOM_SMTP_PORT is not a port number');
  const publicUrl = env.HARKROOM_PUBLIC_URL!.trim().replace(/\/+$/, '');
  let parsed: URL;
  try { parsed = new URL(publicUrl); } catch { throw new Error('mail: HARKROOM_PUBLIC_URL is not a URL'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('mail: HARKROOM_PUBLIC_URL must be http(s)');
  if (parsed.search || parsed.hash) throw new Error('mail: HARKROOM_PUBLIC_URL must not have a query or fragment');
  return {
    host: env.HARKROOM_SMTP_HOST!.trim(),
    port,
    user: set('HARKROOM_SMTP_USER') ? env.HARKROOM_SMTP_USER!.trim() : null,
    password: set('HARKROOM_SMTP_PASSWORD') ? env.HARKROOM_SMTP_PASSWORD! : null,
    from: env.HARKROOM_MAIL_FROM!.trim(),
    publicUrl,
  };
}

/**
 * SMTP 전송부. 465 는 처음부터 TLS, 그 밖의 포트는 STARTTLS 를 **요구한다**(`requireTLS`) — 평문으로
 * 내려앉으면 토큰이 든 메일과 SMTP 비밀번호가 선 위에 그대로 흐른다.
 */
export function createSmtpTransport(cfg: MailConfig, opts: { timeoutMs?: number } = {}): MailTransport {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const t = createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    requireTLS: cfg.port !== 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password! } : undefined,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
  return {
    async send(msg) {
      await t.sendMail({ from: cfg.from, to: msg.to, subject: msg.subject, text: msg.text });
    },
  };
}
