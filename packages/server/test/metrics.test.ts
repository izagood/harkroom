import { describe, it, expect } from 'vitest';
import { createMetrics } from '../src/metrics.js';

describe('metrics registry', () => {
  it('counts requests by method, route and status', () => {
    const m = createMetrics();
    m.observeRequest({ method: 'GET', route: '/healthz', status: 200, durationMs: 3 });
    m.observeRequest({ method: 'GET', route: '/healthz', status: 200, durationMs: 5 });
    m.observeRequest({ method: 'POST', route: '/auth/login', status: 401, durationMs: 120 });

    const text = m.render();

    expect(text).toContain('murmur_http_requests_total{method="GET",route="/healthz",status="200"} 2');
    expect(text).toContain('murmur_http_requests_total{method="POST",route="/auth/login",status="401"} 1');
  });

  // 라벨에 원시 URL 을 쓰면 채널 id·메시지 id 마다 시계열이 하나씩 생겨 카디널리티가 폭발한다.
  // Fastify 의 라우트 패턴(`/channels/:id/messages`)을 쓰는 것이 요점이다.
  it('keeps the route pattern rather than the concrete path', () => {
    const m = createMetrics();
    m.observeRequest({ method: 'GET', route: '/channels/:id/messages', status: 200, durationMs: 1 });

    expect(m.render()).toContain('route="/channels/:id/messages"');
  });

  it('exposes a duration histogram with cumulative buckets', () => {
    const m = createMetrics();
    m.observeRequest({ method: 'GET', route: '/x', status: 200, durationMs: 3 });
    m.observeRequest({ method: 'GET', route: '/x', status: 200, durationMs: 700 });

    const text = m.render();

    // 버킷은 누적이다: 3ms 는 le="0.005" 부터, 700ms 는 le="1" 부터 들어간다.
    expect(text).toMatch(/murmur_http_request_duration_seconds_bucket\{[^}]*le="0.005"\} 1/);
    expect(text).toMatch(/murmur_http_request_duration_seconds_bucket\{[^}]*le="1"\} 2/);
    expect(text).toMatch(/murmur_http_request_duration_seconds_bucket\{[^}]*le="\+Inf"\} 2/);
    expect(text).toMatch(/murmur_http_request_duration_seconds_count\{[^}]*\} 2/);
  });

  it('renders gauges from collectors at scrape time', async () => {
    const m = createMetrics();
    let live = 0;
    m.registerGauge('murmur_ws_connections', 'live websocket connections', () => live);
    live = 7;

    expect(await m.renderAsync()).toContain('murmur_ws_connections 7');
  });

  // 게이지 수집이 던지면(DB 다운 등) 스크레이프 전체가 500 이 되면 안 된다 —
  // 나머지 지표는 그때 특히 필요하다.
  it('skips a gauge whose collector fails instead of failing the scrape', async () => {
    const m = createMetrics();
    m.registerGauge('murmur_broken', 'always fails', () => { throw new Error('db down'); });
    m.registerGauge('murmur_fine', 'works', () => 1);

    const text = await m.renderAsync();

    expect(text).toContain('murmur_fine 1');
    expect(text).not.toContain('murmur_broken');
  });

  it('emits a valid exposition header for every metric', () => {
    const m = createMetrics();
    m.observeRequest({ method: 'GET', route: '/x', status: 200, durationMs: 1 });

    const text = m.render();

    expect(text).toContain('# TYPE murmur_http_requests_total counter');
    expect(text).toContain('# TYPE murmur_http_request_duration_seconds histogram');
  });

  // repo 별 커서처럼 라벨이 붙는 게이지. 라벨 값은 스크레이프 시점에 결정된다(repo 는
  // 채널 설정으로 늘어난다) — 그래서 등록 시점에 알 수 없고 수집기가 함께 돌려줘야 한다.
  it('renders a labeled gauge with one line per label value', async () => {
    const m = createMetrics();
    m.registerLabeledGauge('murmur_projection_cursor', 'cursor per repo', 'repo', () => ({
      'org/a': 7,
      'org/b': 0,
    }));

    const text = await m.renderAsync();

    expect(text).toContain('# TYPE murmur_projection_cursor gauge');
    expect(text).toContain('murmur_projection_cursor{repo="org/a"} 7');
    expect(text).toContain('murmur_projection_cursor{repo="org/b"} 0');
  });

  it('omits a labeled gauge entirely when its collector fails', async () => {
    const m = createMetrics();
    m.registerLabeledGauge('murmur_broken', 'fails', 'repo', () => { throw new Error('db down'); });

    expect(await m.renderAsync()).not.toContain('murmur_broken');
  });
});
