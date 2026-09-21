/**
 * 전달 — 러너가 서버에 하던 말을 오퍼레이터가 대신 한다(스펙 2026-09-20 §5 MCP 행).
 *
 * **인증만 바꾼다.** `Authorization` 을 오퍼레이터 토큰으로, `X-Harkroom-Agent` 를 그 러너의
 * 에이전트 id 로. 서버는 그 쌍이 `agent_assignment` 에 있는지 보고 요청을 그 에이전트로 세운다
 * (배정이 곧 인가). 본문은 열지 않는다 — MCP 핸들러도 REST 라우트도 서버 쪽은 무변경이다.
 *
 * MCP 는 Streamable HTTP 라 요청 하나가 POST 하나다. 답은 JSON 한 개일 수도, SSE 스트림일
 * 수도 있고(서버 SDK 가 정한다), 알림이면 202 에 본문이 없다 — 셋을 전부 JSON-RPC 메시지
 * **목록**으로 편다. 요청마다 fetch 하나이므로 하네스가 요청을 병렬로 내도(롱폴 `inbox.poll`
 * 이 25초 열려 있는 동안 `tools/list`) 서로 막지 않는다 — 계획서 4.1 이 재려던 "직렬인가"는
 * 이 구조에서 물음 자체가 사라진다.
 *
 * REST 는 경로를 베이스 아래로만 허용한다. 오퍼레이터는 열린 프록시가 아니다.
 */
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';

export interface ForwardTarget {
  baseUrl: string;
  token: string;
  agentId: string;
}

export interface Forwarder {
  forward(target: ForwardTarget, req: RunnerLinkRequest): Promise<RunnerLinkResponse>;
}

/** SSE 본문에서 `data:` 줄들을 JSON 으로 편다. 파싱 안 되는 줄은 버린다 — 지어내지 않는다. */
export function parseSseMessages(text: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.split(/\n\n+/)) {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch { /* 깨진 이벤트는 버린다 */ }
  }
  return out;
}

export function createForwarder(deps: { fetchImpl?: typeof fetch } = {}): Forwarder {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headersFor = (target: ForwardTarget): Record<string, string> => ({
    authorization: `Bearer ${target.token}`,
    'x-harkroom-agent': target.agentId,
  });

  return {
    async forward(target, req) {
      const base = target.baseUrl.replace(/\/$/, '');
      if (req.type === 'mcp.request') {
        let res: Response;
        try {
          res = await fetchImpl(`${base}/mcp`, {
            method: 'POST',
            headers: {
              ...headersFor(target),
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify(req.payload),
          });
        } catch (err) {
          return { type: 'mcp.error', id: req.id, status: 0, message: err instanceof Error ? err.message : String(err) };
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return { type: 'mcp.error', id: req.id, status: res.status, message: text || res.statusText };
        }
        if (res.status === 202 || res.status === 204) return { type: 'mcp.response', id: req.id, messages: [] };
        const contentType = res.headers.get('content-type') ?? '';
        const text = await res.text();
        if (contentType.includes('text/event-stream')) {
          return { type: 'mcp.response', id: req.id, messages: parseSseMessages(text) };
        }
        if (!text.trim()) return { type: 'mcp.response', id: req.id, messages: [] };
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch {
          return { type: 'mcp.error', id: req.id, status: res.status, message: `MCP 응답을 JSON 으로 읽지 못했다` };
        }
        return { type: 'mcp.response', id: req.id, messages: Array.isArray(parsed) ? parsed : [parsed] };
      }

      // http.forward — 경로는 베이스 아래여야 한다. 절대 URL·상위 이동은 400 으로 막는다.
      if (!req.path.startsWith('/') || req.path.startsWith('//') || req.path.includes('..')) {
        return { type: 'http.response', id: req.id, status: 400, body: JSON.stringify({ error: { code: 'bad_path', message: '베이스 아래 경로만 전달한다' } }) };
      }
      try {
        const res = await fetchImpl(`${base}${req.path}`, {
          method: req.method,
          headers: {
            ...headersFor(target),
            ...(req.contentType ? { 'content-type': req.contentType } : {}),
          },
          ...(req.body !== undefined ? { body: req.body } : {}),
        });
        return { type: 'http.response', id: req.id, status: res.status, body: await res.text() };
      } catch (err) {
        return { type: 'http.response', id: req.id, status: 0, body: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
