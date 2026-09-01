/**
 * Prometheus 텍스트 노출 형식의 최소 레지스트리.
 *
 * 의존성을 안 쓴 이유는 레이트 리미터와 같다 — 병렬 브랜치와 락파일이 충돌하는 것을 피하고,
 * 필요한 것이 카운터 하나·히스토그램 하나·게이지 몇 개뿐이다.
 *
 * 라벨 카디널리티가 이 파일의 유일한 함정이다. 원시 URL 을 라벨로 쓰면 채널 id·메시지 id
 * 마다 시계열이 하나씩 생겨 스크레이프가 곧 메모리 사고가 된다. 그래서 라우트는 **Fastify 의
 * 패턴**(`/channels/:id/messages`)만 받는다.
 */
export interface RequestObservation {
  method: string;
  route: string;
  status: number;
  durationMs: number;
}

export interface Metrics {
  observeRequest(o: RequestObservation): void;
  /** 스크레이프 시점에 값을 읽는 게이지. 동기·비동기 수집기 모두 허용한다. */
  registerGauge(name: string, help: string, collect: () => number | Promise<number>): void;
  /**
   * 라벨이 붙는 게이지(repo 별 커서 등). 라벨 값은 **등록 시점에 알 수 없다** — repo 는 채널
   * 설정으로 늘어난다. 그래서 수집기가 라벨 값 → 수치 맵을 스크레이프마다 함께 돌려준다.
   */
  registerLabeledGauge(
    name: string, help: string, labelName: string,
    collect: () => Record<string, number> | Promise<Record<string, number>>,
  ): void;
  /** 게이지 없이 카운터·히스토그램만 렌더한다(동기 경로, 테스트용). */
  render(): string;
  /** 게이지까지 포함한 전체 노출. `/metrics` 가 쓰는 경로다. */
  renderAsync(): Promise<string>;
}

/** 초 단위 버킷. 웹 요청의 관심 구간(수 ms ~ 수 초)에 맞췄다. */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const escapeLabel = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export function createMetrics(): Metrics {
  const counters = new Map<string, number>();
  const histograms = new Map<string, { counts: number[]; sum: number; total: number }>();
  const gauges: { name: string; help: string; collect: () => number | Promise<number> }[] = [];
  const labeledGauges: {
    name: string; help: string; labelName: string;
    collect: () => Record<string, number> | Promise<Record<string, number>>;
  }[] = [];

  const keyOf = (o: RequestObservation): string =>
    `method="${escapeLabel(o.method)}",route="${escapeLabel(o.route)}",status="${o.status}"`;

  return {
    observeRequest(o) {
      const key = keyOf(o);
      counters.set(key, (counters.get(key) ?? 0) + 1);

      const seconds = o.durationMs / 1000;
      const h = histograms.get(key) ?? { counts: new Array(BUCKETS.length).fill(0), sum: 0, total: 0 };
      for (let i = 0; i < BUCKETS.length; i += 1) {
        if (seconds <= BUCKETS[i]!) h.counts[i]! += 1;
      }
      h.sum += seconds;
      h.total += 1;
      histograms.set(key, h);
    },

    registerGauge(name, help, collect) {
      gauges.push({ name, help, collect });
    },

    registerLabeledGauge(name, help, labelName, collect) {
      labeledGauges.push({ name, help, labelName, collect });
    },

    render() {
      const lines: string[] = [];
      lines.push('# HELP murmur_http_requests_total total http requests');
      lines.push('# TYPE murmur_http_requests_total counter');
      for (const [labels, count] of counters) {
        lines.push(`murmur_http_requests_total{${labels}} ${count}`);
      }
      lines.push('# HELP murmur_http_request_duration_seconds request duration');
      lines.push('# TYPE murmur_http_request_duration_seconds histogram');
      for (const [labels, h] of histograms) {
        // 버킷은 누적이다. 마지막에 +Inf 와 sum·count 가 와야 형식이 유효하다.
        for (let i = 0; i < BUCKETS.length; i += 1) {
          lines.push(`murmur_http_request_duration_seconds_bucket{${labels},le="${BUCKETS[i]}"} ${h.counts[i]}`);
        }
        lines.push(`murmur_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${h.total}`);
        lines.push(`murmur_http_request_duration_seconds_sum{${labels}} ${h.sum}`);
        lines.push(`murmur_http_request_duration_seconds_count{${labels}} ${h.total}`);
      }
      return `${lines.join('\n')}\n`;
    },

    async renderAsync() {
      const lines: string[] = [this.render().trimEnd()];
      for (const g of gauges) {
        try {
          const value = await g.collect();
          lines.push(`# HELP ${g.name} ${g.help}`);
          lines.push(`# TYPE ${g.name} gauge`);
          lines.push(`${g.name} ${value}`);
        } catch {
          // 게이지 하나가 던져서 스크레이프 전체가 죽으면 안 된다 — 나머지 지표는 그때 특히
          // 필요하다(DB 가 내려간 상황에서 요청 에러율을 못 보는 것이 최악이다).
        }
      }
      for (const g of labeledGauges) {
        try {
          const values = await g.collect();
          // 헤더는 값을 얻은 뒤에 쓴다 — 수집이 실패하면 그 지표를 통째로 생략해야 한다.
          lines.push(`# HELP ${g.name} ${g.help}`);
          lines.push(`# TYPE ${g.name} gauge`);
          for (const [label, value] of Object.entries(values)) {
            lines.push(`${g.name}{${g.labelName}="${escapeLabel(label)}"} ${value}`);
          }
        } catch {
          // 위와 같다 — 게이지 하나가 스크레이프 전체를 죽이지 않는다.
        }
      }
      return `${lines.join('\n')}\n`;
    },
  };
}
