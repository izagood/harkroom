// avcs-server 프로토콜(docs/26)에 대한 wire 가정은 이 파일에만 둔다.
//
// 서버가 내보내는 것은 content-addressed 객체의 append-only 로그(objlog)이고, murmur가
// 필요한 것은 채널에 문장으로 붙일 수 있는 의미론적 이벤트다. 그 환원이 이 파일의 일이다:
//   GET /<org>/<repo>/sync?since=N   → { oids, cursor }
//   POST /<org>/<repo>/objects/fetch → { objects, truncated }
//   GET /<org>/<repo>/events?...     → { cursor, oids, refs }   (204를 쓰지 않는다)
// repo 식별자는 "<org>/<repo>" 두 세그먼트다 — 세그먼트별로 인코딩해야 하며, 전체를
// encodeURIComponent 하면 '/'가 %2F가 되어 라우팅되지 않는다.

export interface AvcsLogEntry {
  logIndex: number;
  oid: string;
  type: 'intent' | 'operation' | 'decision' | 'evidence' | 'integration' | 'checkpoint' | 'release' | 'finalize' | 'lease';
  actorKeyId: string | null;
  intentOid: string | null;
  summary: string;
  lease?: { path: string; expiresAt: string; released: boolean };
}

export interface AvcsServerClient {
  waitForChange(repo: string, since: number, timeoutMs: number): Promise<boolean>;
  fetchSince(repo: string, since: number): Promise<{ entries: AvcsLogEntry[]; next: number }>;
}

/** oid는 `<type>_<digest>`다(avcs computeOid). 페치 전에 타입을 알 수 있으므로, 투영하지 않는
 *  객체(blob·session·view·policy·membership …)는 네트워크에 실리지도 않는다. blob까지 실어오면
 *  배치 바이트 한도를 콘텐츠가 차지해 정작 필요한 거버넌스 객체가 밀려난다. */
const PROJECTED = new Set(['intent', 'operation', 'decision', 'evidence', 'checkpoint', 'release', 'lease']);

/** objects/fetch 한 번에 요청하는 oid 수. 서버 한도는 4096이지만, 바이트 한도(4MB)가 실질
 *  제약이라 훨씬 보수적으로 잡는다 — 한 청크가 잘리면 그 뒤는 이번 사이클에 못 쓴다. */
export const FETCH_CHUNK = 256;

function typeOfOid(oid: string): string {
  const cut = oid.indexOf('_');
  return cut > 0 ? oid.slice(0, cut) : '';
}

function repoPath(repo: string): string {
  return repo.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

interface AvcsObject {
  type: string;
  oid?: string;
  [key: string]: unknown;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** murmur는 actorKeyId를 account_key.key_id로 되짚는다. 객체가 들고 있는 신원은 Actor.id다. */
function actorId(actor: unknown): string | null {
  if (typeof actor !== 'object' || actor === null) return null;
  return str((actor as { id?: unknown }).id) || null;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** decision·evidence는 intentOid를 직접 들고 있지 않고 operation을 참조한다. 스레드에 붙이려면
 *  그 op를 거쳐 intent를 찾아야 한다 — 이 함수가 "어느 op를 거칠지"만 답한다. */
function referencedOp(obj: AvcsObject): string | null {
  if (obj.type === 'decision') return strList(obj.chosenOps)[0] ?? null;
  if (obj.type === 'evidence') return strList(obj.forOps)[0] ?? null;
  return null;
}

/** 하나의 avcs 객체를 murmur 로그 엔트리로 환원한다. lease는 스코프당 하나씩 나오므로 배열이다. */
function toEntries(
  obj: AvcsObject,
  oid: string,
  logIndex: number,
  intentOfOp: (opOid: string) => string | null,
): AvcsLogEntry[] {
  switch (obj.type) {
    case 'intent':
      return [{
        logIndex,
        oid,
        type: 'intent',
        actorKeyId: str(obj.owner) || null,
        intentOid: oid,
        summary: str(obj.title),
      }];
    case 'operation':
      return [{
        logIndex,
        oid,
        type: 'operation',
        actorKeyId: actorId(obj.actor),
        intentOid: str(obj.intentOid) || null,
        summary: str(obj.declaredPurpose),
      }];
    case 'decision': {
      const ref = referencedOp(obj);
      return [{
        logIndex,
        oid,
        type: 'decision',
        actorKeyId: actorId(obj.decidedBy),
        intentOid: ref ? intentOfOp(ref) : null,
        summary: str(obj.reason),
      }];
    }
    case 'evidence': {
      const ref = referencedOp(obj);
      return [{
        logIndex,
        oid,
        type: 'evidence',
        actorKeyId: actorId(obj.producedBy),
        intentOid: ref ? intentOfOp(ref) : null,
        summary: `${str(obj.kind)} ${str(obj.result)}`.trim(),
      }];
    }
    // checkpoint·release는 특정 intent에 속하지 않는다(여러 intent의 결과를 묶은 상태 벡터다)
    // — intentOid를 null로 두어 채널 최상위에 남긴다.
    case 'checkpoint':
      return [{
        logIndex,
        oid,
        type: 'checkpoint',
        actorKeyId: null,
        intentOid: null,
        summary: str(obj.summary),
      }];
    case 'release':
      return [{
        logIndex,
        oid,
        type: 'release',
        actorKeyId: strList(obj.signedBy)[0] ?? null,
        intentOid: null,
        summary: `${str(obj.version) || str(obj.treeHash)} ${str(obj.status)}`.trim(),
      }];
    case 'lease': {
      const expiresAt = str(obj.expiresAt);
      const released = typeof obj.releasedAt === 'string' && obj.releasedAt.length > 0;
      const actorKeyId = actorId(obj.actor);
      const intentOid = str(obj.intentOid) || null;
      // active_lease의 키는 (repo, path, actor_key_id)다 — 스코프마다 행이 하나씩 필요하다.
      return strList(obj.writeScopes).map((path) => ({
        logIndex,
        oid,
        type: 'lease' as const,
        actorKeyId,
        intentOid,
        summary: path,
        lease: { path, expiresAt, released },
      }));
    }
    default:
      return [];
  }
}

export function httpAvcsClient(baseUrl: string): AvcsServerClient {
  const base = baseUrl.replace(/\/$/, '');

  async function fetchObjects(repo: string, oids: string[]): Promise<Map<string, AvcsObject>> {
    const out = new Map<string, AvcsObject>();
    for (let i = 0; i < oids.length; i += FETCH_CHUNK) {
      const res = await fetch(`${base}/${repoPath(repo)}/objects/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oids: oids.slice(i, i + FETCH_CHUNK) }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`avcs objects/fetch failed: ${res.status}`);
      const body = (await res.json()) as { objects: AvcsObject[]; truncated?: boolean };
      // 응답은 요청 순서와 정렬되지 않는다(서버가 없는 oid를 건너뛴다). 저장된 객체는 자기 oid를
      // 들고 있으므로(store.put이 `{...payload, oid}`로 기록) 그것으로 되짚는다.
      for (const o of body.objects) {
        if (typeof o.oid === 'string') out.set(o.oid, o);
      }
      // 바이트 한도로 잘렸다면 이 청크에 빈 구멍이 생겼다. 그 구멍 뒤로는 커서가 못 가므로
      // 나머지 청크를 더 받아봐야 이번 사이클에 쓸 수 없다.
      if (body.truncated) break;
    }
    return out;
  }

  return {
    async waitForChange(repo, since, timeoutMs) {
      const res = await fetch(
        `${base}/${repoPath(repo)}/events?since=${since}&timeoutMs=${timeoutMs}`,
        { signal: AbortSignal.timeout(timeoutMs + 10_000) },
      );
      if (!res.ok) throw new Error(`avcs events failed: ${res.status}`);
      const body = (await res.json()) as { oids?: string[] };
      // 서버는 타임아웃에도 200 + 빈 oids로 답한다. 변경 신호는 상태코드가 아니라 oids다.
      return (body.oids ?? []).length > 0;
    },

    async fetchSince(repo, since) {
      const res = await fetch(`${base}/${repoPath(repo)}/sync?since=${since}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`avcs sync failed: ${res.status}`);
      const body = (await res.json()) as { oids: string[]; cursor: number };
      const oids = body.oids ?? [];

      // logIndex는 필터 전 objlog 위치다 — 건너뛴 객체가 번호를 당겨쓰면 커서 의미가 깨진다.
      const wanted = oids
        .map((oid, i) => ({ oid, logIndex: since + i + 1 }))
        .filter(({ oid }) => PROJECTED.has(typeOfOid(oid)));
      if (!wanted.length) return { entries: [], next: body.cursor };

      const objects = await fetchObjects(repo, wanted.map((w) => w.oid));

      // op → intent. 이번 배치의 operation에서 먼저 채운다.
      const intentOfOp = new Map<string, string | null>();
      for (const [oid, obj] of objects) {
        if (obj.type === 'operation') intentOfOp.set(oid, str(obj.intentOid) || null);
      }
      // decision·evidence가 참조하는 op가 앞선 배치에 있었다면 여기 없다. 모르는 것만 모아
      // 한 번 더 페치한다 — oid당 GET을 돌리면 N+1이 된다.
      const missing = new Set<string>();
      for (const obj of objects.values()) {
        const ref = referencedOp(obj);
        if (ref && !intentOfOp.has(ref)) missing.add(ref);
      }
      if (missing.size) {
        for (const [oid, obj] of await fetchObjects(repo, [...missing])) {
          if (obj.type === 'operation') intentOfOp.set(oid, str(obj.intentOid) || null);
        }
      }
      const lookup = (opOid: string): string | null => intentOfOp.get(opOid) ?? null;

      const entries: AvcsLogEntry[] = [];
      let next = body.cursor;
      for (const { oid, logIndex } of wanted) {
        const obj = objects.get(oid);
        if (!obj) {
          // 배치가 실어오지 못한 객체(바이트 한도로 잘림, 또는 경합된 eviction). 커서를 이 앞에
          // 세워 다음 폴에서 다시 받는다 — 넘겨버리면 그 객체는 영구히 투영되지 않는다.
          next = Math.min(next, logIndex - 1);
          break;
        }
        entries.push(...toEntries(obj, oid, logIndex, lookup));
      }
      return { entries, next };
    },
  };
}
