/**
 * 로그로 자격증명이 새지 않게 만드는 지점.
 *
 * WS 티켓은 URL 쿼리에 실린다 — 브라우저 WebSocket 생성자가 헤더를 못 붙여서다. 그 URL 을
 * 그대로 로깅하면 "URL 은 프록시 로그에 남는다"는 티켓 도입 이유가 우리 로그에서 그대로
 * 재현된다. Bearer 토큰도 같다: 로그는 오래 남고 널리 읽히므로, 토큰이 적히면 로그 열람
 * 권한이 곧 계정 권한이 된다.
 */
const SENSITIVE_QUERY = /([?&](?:ticket|token|idempotency-key)=)[^&]*/gi;

export function redactUrl(url: string): string {
  return url.replace(SENSITIVE_QUERY, '$1REDACTED');
}

export interface LoggerOptions {
  level: string;
  stream?: import('node:stream').Writable;
}

/** Fastify 로거 설정. 민감값 제거를 기본값으로 굳혀 둔다(호출부가 잊을 수 있으므로). */
export function loggerConfig(opts: LoggerOptions): Record<string, unknown> {
  return {
    level: opts.level,
    ...(opts.stream ? { stream: opts.stream } : {}),
    // 직렬화기가 헤더를 안 실어도 남겨 둔다 — 나중에 헤더를 로깅하는 코드가 들어올 때의 안전망.
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], remove: true },
    serializers: {
      req: (req: { id?: string; method: string; url: string }) => ({
        method: req.method,
        url: redactUrl(req.url),
      }),
    },
  };
}
