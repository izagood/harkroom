# `*.harkroom.com` — 홈랩 k8s 에 서브도메인마다 한 인스턴스

기존 self-host 서버를 홈랩 k8s 로 옮기고, 사용자가 서버를 만들면 서브도메인으로 갈라
각각 제공한다. 기존 데이터 이관은 **이번 한 번만** 하는 일이라 3장에 따로 뒀다.

## 0. 조사로 확정한 전제

계획이 이 네 가지 위에 서 있다. 다르게 기억하고 있었다면 여기서 갈린다.

| 사실 | 근거 | 계획에 미치는 것 |
|---|---|---|
| 서버는 **단일 테넌트**다 | 53개 마이그레이션 어디에도 `tenant_id`·`workspace_id` 가 없다. `config.ts` 에도 없다. README 가 multi-tenancy 를 v2+ out of scope 로 적는다 | 앱에 테넌시를 넣지 **않는다**. 서브도메인 = 독립 인스턴스 |
| 이미지는 이미 k8s 를 안다 | `Dockerfile`: `USER 1000:1000`(숫자 — `runAsNonRoot` 대응), `/readyz`·`/healthz`, `ATTACHMENT_ROOT` 기본값 내장. `image.yml` 이 amd64+arm64 매니페스트 리스트로 ghcr 에 민다 | **이미지 작업이 없다.** `ghcr.io/<owner>/harkroom-server:<버전>` 을 그대로 쓴다 |
| 프록시 뒤 동작이 env 로 나와 있다 | `config.ts` 의 `trustProxy`·`corsOrigins` | ingress 뒤에서 `TRUST_PROXY=1` 이 **필수**다(아래 1-4) |
| 데스크탑은 임의 서버 URL 을 받는다 | `ConnectScreen.tsx` 의 `baseUrl` 입력 + `mode: 'add'` 로 여러 커뮤니티 동시 등록 | 기존 흐름은 **클라이언트 변경이 0 이다.** 4장의 `create` 모드만 새로 붙는다(4-9) |

마이그레이션은 기동 시 `runMigrations` 가 advisory lock 으로 직렬화해 적용하고
`schema_migrations` 로 판정한다(`main.ts`). → **빈 DB 만 주면 새 인스턴스가 스스로 스키마를
만든다.** 이것이 3장의 이관과 4장의 프로비저닝 양쪽의 근거다.

## 1. 토폴로지 — 무엇이 하나이고 무엇이 여럿인가

```
                  Cloudflare 엣지 (TLS 종료, *.harkroom.com)
                        │ outbound 터널
                  cloudflared (ns: cloudflared, replicas 2)
                        │ http
                  istio-ingressgateway
                        │ Gateway hosts + VirtualService 로 분배
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   app.harkroom.com  alice.…        bob.…
   ns: harkroom-app  ns: harkroom-  ns: harkroom-bob
                     alice
   server+cnpg+pvc   server+cnpg+pvc server+cnpg+pvc
```

**인스턴스마다 네임스페이스 하나.** 한 네임스페이스 안에 `server` Deployment ·
Postgres(StatefulSet) · 첨부 PVC 가 들어간다. 공유하지 않는 이유:

- 서버가 단일 테넌트라 **DB 를 공유하면 두 워크스페이스의 계정·채널이 한 `account`·
  `channel` 테이블에서 섞인다.** 격리가 아니라 사고다.
- `/bootstrap` 은 "사람 계정이 하나라도 있으면 409"(README)다. DB 가 공유되면 **두 번째
  사용자가 자기 워크스페이스를 부트스트랩할 수 없다.**
- 네임스페이스가 곧 ResourceQuota·NetworkPolicy·백업 단위가 된다.

### 1-1. 왜 Postgres 도 인스턴스마다인가

한 Postgres 에 DB 만 나누는(`harkroom_alice`, `harkroom_bob`) 안도 된다. 자원은 확실히
덜 먹는다. 그럼에도 **인스턴스마다 두는 쪽을 기본으로 권한다**: 홈랩 미니PC 에서 공유
Postgres 는 단일 장애점이고, 한 워크스페이스의 복구가 다른 워크스페이스를 멈춰 세운다.

**구현은 CloudNativePG(CNPG) 다** — 손으로 만든 StatefulSet 이 아니다. homelab 레포가
avcshub·rowlol·avcshub-dev 를 전부 CNPG 로 통일해 두었고(`local-path` 는 노드 고착·확장
불가라는 이유가 rowlol 주석에 적혀 있다), 스토리지는 `synology-iscsi`(NAS)다.

> ⚠️ **백업은 아직 없다.** CNPG 의 `barmanObjectStore`(R2) 를 붙이면 백업·PITR 이 그대로
> 오지만 이번에는 넣지 않기로 했다. 그래서 지금 테넌트 DB 는 **유실 시 복구 수단이 없다** —
> rowlol 이 전환 전까지 있던 그 상태다. 실사용자를 받기 전에 붙인다. 붙는 자리는
> `postgres.yaml` 에 주석으로 표시해 두었다.

### 1-2. 와일드카드 DNS 와 터널

**이 절은 끝났다**(homelab PR #115, `c280a51`). 기록으로 남긴다.

터널 하나가 `*.harkroom.com` 을 전부 받아 **istio-ingressgateway** 로 넘기고, Gateway 의
`hosts` 와 VirtualService 가 Host 헤더로 가른다.

DNS 는 **external-dns 가 만든다** — `cloudflared tunnel route dns` 를 손으로 부르지 않는다.
`DNSEndpoint` 리소스를 클러스터에 두면 external-dns 가 Cloudflare 에 레코드를 민다
(`--domain-filter` 에 `harkroom.com` 이 들어가 있어야 한다 — 확인됨).

현재 상태: apex CNAME · 와일드카드 CNAME · 소유권 TXT 세 개가 생성됐고 `harkroom.com` 과
`*.harkroom.com` 이 Cloudflare 엣지로 해석된다. 엣지 도달은 `cf-ray` 헤더로 확인됐다.

**지금 404 가 나는 것은 정상이다.** Envoy 라우트 테이블에 harkroom virtual host 가 없기
때문인데, Istio 는 Gateway `hosts` 에 올려도 **매칭되는 VirtualService 가 없으면 virtual
host 를 만들지 않는다.** 그 VirtualService 가 2-1 의 인스턴스 템플릿에 들어 있고, 첫
인스턴스가 배포되는 순간 붙는다.

TLS 는 엣지에서 끝난다. cloudflared→게이트웨이 구간은 HTTP 라 **인스턴스마다 인증서를
발급할 일이 없다** — cert-manager 는 이 경로에 필요 없다.

### 1-3. WebSocket

harkroom 은 실시간 WS 가 본체다(`ws/wsPlugin.ts`, `/ws-ticket`). 두 곳을 확인해야 한다:

- **Cloudflare**: WebSocket 은 기본 켜져 있다. 끄지 않았는지만 본다.
- **Istio**: VirtualService 의 `timeout` 은 **기본이 없음(무제한)** 이라 nginx 처럼 60초에
  끊기지 않는다. 다만 **명시적으로 `timeout` 을 적으면 WS 도 그 값에 걸리므로**, 이
  라우트에는 적지 않거나 충분히 크게 둔다:

```yaml
# VirtualService — WS 경로에 timeout 을 걸지 않는다
http:
  - route:
      - destination: { host: harkroom-server.hr-<이름>.svc.cluster.local, port: { number: 3400 } }
    # timeout: 생략 (적으면 유휴 WS 가 그 값에서 끊긴다)
```

  하트비트가 30초(`wsHeartbeatMs`)라 중간 장비가 끊어도 회복되지만, 끊을 이유를 만들지
  않는 편이 낫다.

### 1-4. `TRUST_PROXY=1` — 켜야 하고, 켜도 안전한 자리

`buildServer.ts` 의 주석이 이 결정을 이미 적어 뒀다. ingress 뒤에서 끄면 **모든 클라이언트가
레이트리밋 버킷 하나를 공유해 서로를 밀어내고**, 감사 로그의 ip 가 전부 같은 값이 된다
(`operations.md` §9 가 compose 배포의 그 증상이다).

켜면 위험한 경우는 "프록시가 없는데 켰을 때"인데, 여기서는 **파드에 닿는 경로가
cloudflared→istio-ingressgateway 뿐**이다. NetworkPolicy 로 `istio-system`(게이트웨이가 사는
네임스페이스)에서 오는 트래픽만 받게 막으면 `X-Forwarded-For` 위조 경로가 닫힌다. 그
NetworkPolicy 를 2-1 템플릿에 포함한다.

> **확인할 것**: Istio 가 `X-Forwarded-For` 를 어떻게 채우는지는 게이트웨이의
> `numTrustedProxies`(meshConfig `gatewayTopology`) 에 달려 있다. cloudflared 가 앞에 한 겹
> 더 있으므로 이 값이 맞지 않으면 **모든 클라이언트가 cloudflared 의 파드 IP 로 보인다** —
> `TRUST_PROXY=1` 을 켜 놓고도 1-4 가 고치려던 그 증상이 그대로 남는다. 첫 인스턴스가
> 뜨면 감사 로그의 ip 가 실제 클라이언트인지 **눈으로 확인한다**(3-4 의 판정에 함께 둔다).

### 1-5. `CORS_ORIGINS`

데스크탑 앱은 `tauri://localhost`(빌드본) 또는 Vite dev origin 을 보낸다(`config.ts` 주석).
비워 두면 모든 origin 을 반영한다 — 셀프호스트 기본값이다. `*.harkroom.com` 에 웹 UI 가
없으므로(README: Web UI 는 out of scope) **당분간 비워 둔다.** 웹을 붙이는 날 인스턴스별
origin 을 넣는다.

## 2. GitOps 레이아웃

**homelab 레포의 기존 구조를 그대로 쓴다.** 새 ApplicationSet 을 만들지 않는다 —
`workloads` ApplicationSet 이 이미 `gitops/apps/workloads/*` 를 훑고 있고, 거기에
디렉터리를 더하는 것만으로 테넌트가 생긴다.

```
gitops/
  apps/platform/            # 전부 완료
    cloudflared/            #   *.harkroom.com 을 받는 터널
    gateways/               #   external-gateway hosts 에 harkroom.com·*.harkroom.com
    external-dns/ sealed-secrets/ cnpg-operator/
  apps/workloads/
    harkroom/               # DNS 만(apex+와일드카드 CNAME) — 테넌트가 늘어도 안 건드린다
    harkroom-app/           # app.harkroom.com  ← 첫 테넌트, 3장의 이관 대상
    harkroom-alice/         # alice.harkroom.com
  applicationsets/
    workloads.yaml          # 기존 것. `namespace: {{.path.basename}}` — 손대지 않는다
```

**ns 이름 = 디렉터리 이름**이다. `hr-` 접두사를 쓰려면 공용 ApplicationSet 을 고쳐야 하고
그러면 avcshub·rowlol 에까지 영향이 간다 — 그래서 `harkroom-<테넌트>` 로 맞춘다.

**원본(`_template/`)을 레포에 두지 않는다.** ApplicationSet 이 `workloads/*` 를 전부 줍기
때문에 원본까지 배포하려 들기 때문이다(`_template` 이라는 ns 에, 치환되지 않은 host 로).
검증된 `harkroom-app/` 이 사실상의 원본이고, gate 를 만들 때 그것을 gate 레포로 가져간다.

### 2-1. 인스턴스 하나가 담는 것

Kustomize 로 두고 `kustomization.yaml` 의 `namePrefix`·`images`·패치만 워크스페이스마다
다르게 둔다.

`harkroom-app/` 에 실제로 들어간 것(kustomize 렌더 + 서버사이드 dry-run 검증 완료):

| 파일 | 메모 |
|---|---|
| `server.yaml` | Deployment + Service + 첨부 PVC. `ghcr.io/izagood/harkroom-server:0.1.206`(amd64+arm64 확인). `strategy: Recreate` — 첨부 PVC 가 RWO 라 RollingUpdate 면 새 파드가 Pending 으로 선다 |
| `postgres.yaml` | **CNPG `Cluster`**. DB·owner 이름은 `murmur`(기존 덤프의 롤과 같아야 `pg_restore --no-owner` 가 맞는다). `Prune=false` 로 GitOps 사고 방어 |
| `virtualservice.yaml` | `hosts: [app.harkroom.com]`, `gateways: [istio-system/external-gateway]`. **`timeout` 을 적지 않는다**(1-3) |
| `harkroom-secret-sealed.yaml` | `DATABASE_URL`. gate 가 채울 `CLAIM_TOKEN_HASH` 도 여기로 들어온다(`optional: true` 라 이 인스턴스에는 없어도 된다) |
| `db-app-sealed.yaml` | CNPG bootstrap 자격증명(`basic-auth`, username=`murmur`) |
| `networkpolicy.yaml` | 1-4 의 근거. **`podSelector: {}`**(ns 전체) 이고 `cnpg-operator`·`monitoring` 을 함께 연다 — 막으면 operator 가 인스턴스 상태를 못 읽어 `Instance Status Extraction Error` 가 난다(avcshub-dev 가 겪은 실제 사고) |
| `resourcequota.yaml`·`limitrange.yaml` | 테넌트가 노드를 독점하지 못하게. LimitRange 가 없으면 리소스를 안 적은 initContainer 때문에 파드 생성이 거부된다 |

**파드 스펙에서 빠지면 안 되는 것 둘:**

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  fsGroup: 1000          # 첨부 PVC 소유권 — 없으면 업로드가 EACCES 로 조용히 실패한다
```

`fsGroup` 은 Dockerfile 주석이 명시적으로 지목한 함정이다(이미지에 없는 경로에 볼륨을 붙이면
root 소유가 되고 uid 1000 이 한 바이트도 못 쓴다). 이미지가 `/var/lib/harkroom` 을 미리
만들어 두지만, **PVC 를 그 위에 덮으면 이미지의 그 준비가 가려진다** — `fsGroup` 이 그것을
메운다.

```yaml
readinessProbe: { httpGet: { path: /readyz, port: 3400 } }
livenessProbe:  { httpGet: { path: /healthz, port: 3400 } }
```

Dockerfile 의 `HEALTHCHECK` 는 k8s 가 읽지 않는다 — 파드에 직접 적는다(그 주석이 그렇게
지시한다).

`replicas: 1` 로 둔다. presence·타이핑·WS 티켓·레이트리밋 카운터가 전부 인메모리라
(`operations.md` §1) **2개로 늘리면 두 파드가 서로 다른 presence 를 본다.** 수평 확장은
이 코드베이스가 아직 지원하지 않는다.

## 3. 기존 서버 데이터 이관 — 이번 한 번

`operations.md` §2~§4 의 절차를 k8s 로 옮긴 것이다. 새로 만드는 절차가 아니라 **이미 문서화된
절차를 그대로 밟는다.** 목적지는 `app.harkroom.com`(= `harkroom-app` 네임스페이스).

### 3-1. 순서가 정해져 있다

§4 가 적은 그대로: **첨부 볼륨을 먼저, DB 를 나중에.** 반대로 하면 DB 행이 가리키는 파일이
백업에 없어 복구 후 '깨진 첨부'가 된다. 볼륨을 먼저 뜨면 그 사이 생긴 파일이 DB 에 없을
뿐이고(고아 파일) 그건 무해하다.

쓰기를 멈추고 뜨는 쪽이 가장 안전하다 — 이관은 한 번뿐이니 다운타임을 받아들인다.

```bash
# ── 기존 서버(compose)에서 ──
docker compose stop server                      # 쓰기를 멈춘다

# 1) 첨부 먼저
docker run --rm -v <프로젝트>_attachments:/data -v "$PWD":/backup alpine \
  tar czf /backup/attachments.tgz -C /data .

# 2) DB 나중에. -Fc 는 단일 트랜잭션 스냅샷이다(§2)
docker compose exec -T postgres pg_dump -U murmur -Fc murmur > murmur.dump
```

### 3-2. 새 인스턴스로 넣는다

먼저 서버를 **replicas 0 으로** 내린다. 살아 있으면 복구 중에 쓰기가 들어가고, 부팅
마이그레이션이 덤프와 스키마를 어긋나게 한다(§3 의 첫 문장).

```bash
kubectl -n harkroom-app scale deploy/harkroom-server --replicas=0
```

**CNPG 라 `dropdb`/`createdb` 를 쓰지 않는다.** 그 DB 는 오퍼레이터가 관리하는 대상이고,
밖에서 지우면 오퍼레이터가 없어진 것을 다시 만들려 들면서 reconcile 이 엉킨다. 대신
**스키마만 비우고** 그 자리에 덤프를 푼다 — 결과는 같고 오퍼레이터의 소유물은 그대로다.

```bash
# CNPG 의 primary 파드. -rw 서비스가 아니라 파드에 직접 붙는다.
PG=$(kubectl -n harkroom-app get pod -l cnpg.io/cluster=postgres,role=primary -o name)

# public 스키마를 비운다(= 빈 DB 와 같은 상태로 만든다)
kubectl -n harkroom-app exec -i "$PG" -- \
  psql -U murmur -d murmur -c 'drop schema public cascade; create schema public;'

# 덤프를 푼다. 기존 compose 와 롤/DB 이름(murmur)이 같으므로 --no-owner 로 충분하다
kubectl -n harkroom-app exec -i "$PG" -- \
  pg_restore -U murmur -d murmur --no-owner < murmur.dump
```

첨부는 PVC 를 붙인 임시 파드로 넣는다:

```bash
kubectl -n harkroom-app run restore --rm -i --image=alpine --overrides='
{"spec":{"containers":[{"name":"restore","image":"alpine","stdin":true,
 "volumeMounts":[{"name":"a","mountPath":"/data"}]}],
 "volumes":[{"name":"a","persistentVolumeClaim":{"claimName":"harkroom-attachments"}}]}}' \
  -- sh -c 'tar xzf - -C /data && chown -R 1000:1000 /data' < attachments.tgz
```

`chown -R 1000:1000` 을 빠뜨리면 **읽기는 되고 업로드만 EACCES 로 실패한다** — 늦게
드러나는 종류의 고장이다. (파드의 `fsGroup: 1000` 이 대개 이것을 덮어 주지만, 먼저
맞춰 두면 그 동작에 기대지 않아도 된다.)

```bash
kubectl -n harkroom-app scale deploy/harkroom-server --replicas=1
```

마지막 줄에 기댈 수 있는 근거는 §3 에 적혀 있다: advisory lock + `schema_migrations`.
**오래된 스키마의 덤프를 새 서버로 복구해도 부팅이 그 차이를 메운다.** 반대 방향은 지원되지
않으므로 — 새 이미지로 옮기는 이 방향은 안전하다.

### 3-3. 이관에 딸려 오지 않는 것

| 대상 | 어떻게 되나 |
|---|---|
| avcs 오브젝트 | **harkroom 의 책임이 아니다**(§1). avcs 서버는 자기 절차로 따로 옮긴다. 옮기지 않으면 채팅은 온전하지만 작업 층이 비고, 투영된 시스템 메시지가 사라진 오브젝트를 가리킨다 |
| 투영 커서 | 덤프에 포함된다. **avcs 를 harkroom 커서보다 뒤로 두지 않는다**(§3-B) — 어기면 그 사이 객체가 조용히 건너뛰어진다. 어쩔 수 없으면 `projection_cursor` 를 0 으로 내린다(멱등) |
| 세션·PAT | 해시가 덤프에 있어 **그대로 산다.** 다만 데스크탑은 `baseUrl` 이 바뀌므로 새 주소로 다시 연결해야 한다 |
| 에이전트 상태 | `AGENT_STATE_DIR`(러너 로컬 디스크). 서버 이관과 무관하게 러너 쪽에서 따라온다 |
| presence·레이트리밋 | 인메모리. 재시작하면 리셋된다 — 백업 대상이 아니다(§1) |

### 3-4. 이관 완료 판정

```bash
curl -s https://app.harkroom.com/healthz          # 버전·커밋이 새 이미지인가
curl -s https://app.harkroom.com/readyz
```

**감사 로그의 ip 를 함께 본다** — 1-4 의 `numTrustedProxies` 가 맞지 않으면 모든 요청이
cloudflared 파드 IP 로 보인다. 첫 인스턴스에서 확인할 것 중 이것만 화면에 안 드러난다.

`operations.md` §7-A 가 "배포가 낡았는지 서버가 스스로 말한다"를 적어 뒀다 — `MURMUR_COMMIT`
이 `image.yml` 에서 심기므로 `/healthz` 가 정확한 커밋을 답해야 한다. 그다음 데스크탑에서
`https://app.harkroom.com` 으로 로그인해 **채널·메시지·첨부 이미지 한 장**을 눈으로 확인한다.
첨부를 굳이 보는 이유는 3-2 의 `chown` 이 조용히 실패하는 자리이기 때문이다.

## 4. 새 워크스페이스 프로비저닝 — `harkroom-gate`

데스크탑에서 **서브도메인 이름을 넘기면 워크스페이스가 생긴다.** 그것을 받는 것이
`harkroom-gate` 다 — GitHub **private** 레포의 별도 서비스다.

harkroom 서버에는 **라우트 하나(`POST /claim`)만** 더한다(4-2). 그 밖의 서버 코드와 기존
`/bootstrap` 은 건드리지 않는다 — 셀프호스트가 쓰는 표면이기 때문이다.

**공개 서비스로 열되, 당분간 초대 코드를 받은 계정만 만들 수 있다.**

### 4-0. 왜 별도 서비스인가 — harkroom 서버로는 안 된다

`POST /bootstrap` 은 **이미 떠 있는 서버**에 첫 계정을 만든다. 27행이 `pool.query` 로 자기
DB 를 보므로 **자기가 존재해야 답할 수 있다.** 만들려는 것이 그 서버 자신이니 닭과 달걀이다.
harkroom 서버에는 네임스페이스·PVC 를 만들 권한도 코드도 없다.

그래서 받는 쪽이 따로 있어야 한다. gate 는 `harkroom.com`(와일드카드가 **아닌** 고정 호스트)
에 선다 — `*.harkroom.com` 은 워크스페이스들의 것이고, 그 와일드카드에 걸리지 않는 자리가
필요하다.

### 4-1. 흐름

```
데스크탑  [서브도메인: alice] [초대 코드] [이메일]   ← 비밀번호를 받지 않는다
    │ POST https://harkroom.com/api/workspaces
    ▼
harkroom-gate
    │ 1. 초대 코드 검증·선점(for update)
    │ 2. 이름 검증 + 예약어 거부
    │ 3. 클레임 토큰 생성 → 해시를 SealedSecret 으로 심는다
    │ 4. git commit → apps/workloads/harkroom-alice/
    ▼
ArgoCD  ──► harkroom-alice 네임스페이스 (server replicas 1, 빈 DB)
    │
    │ gate 가 /readyz 를 폴링
    ▼
데스크탑 ◄── { url, claimToken } ── status: ready
    │
    │ 사용자가 **자기 비밀번호를 여기서 처음 정한다**
    ▼
POST https://alice.harkroom.com/claim  { claimToken, loginId, handle, password }
    └─ 비밀번호는 사용자 기계 → 자기 인스턴스 **직행**. gate 를 거치지 않는다
```

**두 가지가 한꺼번에 풀린다.** gate 는 사용자 비밀번호를 영영 보지 못하고(자기가 만든
클레임 토큰만 안다), 동시에 *"주소를 아는 누구나 첫 관리자가 되는 창"* 이 닫힌다 — 토큰을
가진 사람만 계정을 만들 수 있기 때문이다. `/bootstrap` 에 인증이 없다는 것이 그 창의
원인이었다.

### 4-2. `POST /claim` — 서버에 더하는 것

**harkroom 서버에 라우트 하나를 더한다.** 기존 `/bootstrap` 은 건드리지 않는다 —
셀프호스트(`docker compose` + curl)가 쓰는 표면이고, 그것이 깨지면 README 의 Quick Start 가
거짓이 된다.

```
POST /claim  { claimToken, loginId, handle, displayName, password }
```

`/bootstrap` 과 하는 일이 같다(첫 관리자 + 기본 채널을 한 트랜잭션으로). **다른 것은 관문
하나**다: 사람 계정이 없는지에 더해 **토큰이 맞는지**를 본다.

```js
// 기존 /bootstrap 의 관문
select 1 from account where kind = 'human' limit 1      → 있으면 409

// /claim 은 여기에 더한다
select token_hash from claim_token where used_at is null for update
  → 없거나 안 맞으면 400
```

세부는 이 저장소에 이미 있는 것을 그대로 쓴다:

| 무엇 | 어디서 | 왜 |
|---|---|---|
| `hashToken` / `newToken` | `auth/tokens.ts` | **원문을 저장하지 않는다.** sha256 해시만 둔다 |
| `for update` 로 선점 | `/auth/register` 의 invite 처리(115행) | 동시 요청 둘이 같은 토큰을 쓰면 하나만 통과 |
| 계정+채널 한 트랜잭션 | `/bootstrap`(41-50행) | 채널 없이 계정만 남으면 **워크스페이스가 굳는다** |
| 감사 기록은 커밋 뒤 | `/bootstrap`(57-66행) | 롤백돼도 로그가 남아 거짓을 말하지 않게 |

토큰은 **env 가 아니라 DB 에 둔다**(`claim_token` 테이블, 마이그레이션 054). env 로 심으면
소진 여부를 기록할 곳이 없어 재시작마다 다시 유효해진다.

`CLAIM_TOKEN_HASH` env 로 초기값을 주고 기동 시 테이블에 한 번 넣는 방식이면 SealedSecret
하나로 끝나므로 gate 쪽이 단순해진다 — **넣을 때 `on conflict do nothing`** 이어야 한다.
아니면 파드가 재시작될 때마다 소진된 토큰이 되살아난다.

**소진 뒤에는 404 로 답한다.** 이미 쓴 토큰에 400 을 주면 *"토큰은 맞는데 뭔가 틀렸다"* 로
읽히고, 사용자는 자기 토큰을 계속 다시 보낸다.

#### 왜 `/bootstrap` 에 토큰을 얹지 않는가

같은 라우트에 *"토큰이 설정돼 있으면 요구하고 아니면 말고"* 를 넣는 안도 있었다. 한 라우트가
**두 가지 보안 모델**을 갖게 되고, 그 분기는 env 하나로 조용히 뒤집힌다 — 설정 실수가 곧
인증 없는 계정 생성이 된다. 라우트를 나누면 `/claim` 은 **항상** 토큰을 요구한다.

#### 레이트 리밋

`/claim` 은 계정 생성 표면이므로 `signup` 규칙(15분 10회)에 넣는다 —
`buildServer.ts` 의 `LIMITED_ROUTES` 에 한 줄이다. 없으면 토큰을 무차별 대입할 수 있다.

### 4-2-1. 데스크탑이 하는 일

생성 화면에서 **비밀번호를 받지 않는다.** 이름과 초대 코드만 받고, `ready` 가 되면
자격증명 입력 화면으로 넘어가 `/claim` 을 부른다. 그 뒤는 기존 로그인 흐름 그대로다.

`ConnectScreen` 이 이미 `bootstrap` 모드에서 `loginId`·`handle`·`displayName`·`password` 를
받고 있으므로, **`/claim` 은 그 폼을 그대로 쓰고 엔드포인트와 토큰만 다르다.**

### 4-2-2. 이메일 — gate 가 받고, 워크스페이스는 모른다

복구 경로가 필요하므로 **gate 가 워크스페이스를 만들 때 이메일을 받는다.** 어디에 두느냐가
이 절의 요점이다.

#### harkroom 서버의 `account` 에 넣지 않는다

`design.md` 의 비목표에 「이메일 알림, OAuth 로그인」이 있다. **그 행이 금지하는 것은 이메일을
저장하는 것이 아니라 서버가 메일을 보내는 것**이므로 컬럼을 더한다고 그 결정을 어기지는
않는다. 그럼에도 넣지 않는 이유는 따로 있다:

1. **셀프호스트가 쓰지 않는 컬럼이 된다.** compose 로 도는 배포에는 메일을 보낼 것이 없어
   `account.email` 은 영영 빈 칸이다. 스키마에 남은 빈 칸은 나중에 "이건 뭐냐"가 된다.
2. **넣는 순간 서버가 메일 발송을 갖고 싶어진다.** 재설정 링크를 보내려면 SMTP 설정·템플릿·
   반송 처리가 서버로 들어오고, 그것이 정확히 비목표가 막는 것이다.
3. **이 저장소는 self-host 제품이고 `*.harkroom.com` 은 내 배포 하나다.** 내 배포의 운영
   편의를 위해 남의 셀프호스트 스키마를 바꾸는 것은 방향이 거꾸로다.

그래서 **`harkroom-gate` 의 DB 에 둔다.** gate 는 이미 private 레포이고 `*.harkroom.com`
전용이라, 이 배포에만 있는 사실을 담기에 맞는 자리다. harkroom 서버는 이메일의 존재를
**모른 채로 남는다.**

```
gate DB:  workspace(name, email, claim_token_hash, created_at, claimed_at, ...)
harkroom: account(handle, login_id, password_hash, ...)   ← 그대로
```

#### 받는 시점 — 생성 요청

```
POST /api/workspaces  { name, inviteCode, email }
```

`/claim` 에는 **넣지 않는다.** 클레임은 사용자 기계에서 인스턴스로 직행하는 요청이고
(4-1), 거기에 이메일을 실으면 **워크스페이스가 그것을 알게 된다** — 위에서 피한 그것이다.

#### 무엇에 쓰는가 — 세 가지뿐

| 용도 | 언제 |
|---|---|
| **본인 확인** | 비밀번호 분실 요청이 왔을 때, 생성 시 이메일과 대조 |
| 만료 예고 | 클레임 안 된 인스턴스가 72시간 뒤 지워지기 전(4-2-4) |
| 회수 예고 | 미사용 워크스페이스 회수 정책(4-8) |

**로그인에 쓰지 않고, 워크스페이스로 흘려보내지 않는다.** 로그인 식별자는 여전히
`login_id` 이고 그것은 인스턴스 안에만 있다.

#### 비밀번호 복구 절차 (반자동)

이메일이 있어도 **자동 재설정 링크는 안 된다.** gate 는 워크스페이스의 DB 에 손댈 권한이
없고(4-7: git 커밋만 한다), 줘서도 안 된다 — gate 가 털리면 모든 워크스페이스의 계정을
갈아 치울 수 있게 된다.

그래서 이렇게 한다:

1. 사용자가 gate 에 복구를 요청한다(이메일 + 워크스페이스 이름)
2. gate 가 그 주소로 확인 링크를 보내고, 사용자가 누른다 — **주소 소유를 증명**한다
3. gate 가 **나에게 알린다.** 자동으로 재설정하지 않는다
4. 내가 `scripts/reset-password.ts` 를 그 네임스페이스에서 돌린다:

```bash
kubectl -n harkroom-alice exec -it deploy/harkroom-server -- \
  env MURMUR_NEW_PASSWORD='<새 비밀번호>' \
  tsx scripts/reset-password.ts <handle>
```

이 도구는 **모든 세션을 삭제**하고 감사 로그에 `password.changed`(`via:
operational_tool`, **actor 는 비어 있다**)를 남긴다(`operations.md` §11). 그 빈 actor 가
말하는 것 — *"서버는 누가 돌렸는지 모른다"* — 이 여기서는 참이 아니므로, **gate 쪽에 누구의
요청으로 돌렸는지를 남긴다.** 두 기록이 합쳐져야 추적이 된다.

2단계를 건너뛰면 **이메일을 아는 사람이 남의 워크스페이스를 재설정시킬 수 있다.** 그게 이
절차에서 유일하게 생략하면 안 되는 단계다.

#### 대가

- **메일을 보낼 수단이 gate 에 필요하다**(확인 링크·예고). 외부 발송 서비스 하나가 붙는다 —
  harkroom 서버가 아니라 gate 의 의존이고, 그래서 비목표를 건드리지 않는다
- **개인정보를 보관하게 된다.** private 레포·전용 DB 라도 사실은 사실이다. 보관 기간과
  워크스페이스 삭제 시 함께 지우는 것을 정해 둔다
- **4번째 단계가 수동이다.** 공개 규모가 커지면 병목이 되지만, 그 지점은 초대 코드를 여는
  시점(4-8)과 같으므로 그때 함께 본다

### 4-2-3. 토큰을 잃어버리면

클레임 전이면 **gate 가 재발급한다** — 아직 아무도 그 인스턴스를 소유하지 않았으므로
새 토큰을 심는 커밋을 밀면 된다. `POST /api/workspaces/<jobId>/reissue`. 재발급 링크는
생성 시 받은 이메일로 보낸다(4-2-2) — 그러지 않으면 `jobId` 를 아는 사람이 남의 인스턴스를
가져갈 수 있다.

클레임 **후**에 비밀번호를 잃은 것은 4-2-2 의 복구 절차로 간다.

### 4-2-4. 클레임되지 않은 인스턴스

만들어졌는데 아무도 클레임하지 않으면 **빈 인스턴스가 자원만 먹는다.** gate 가 만료를 둔다:
`claim_token` 에 `expires_at`(예: 72시간), 지나면 gate 가 되돌리는 커밋을 밀어 네임스페이스를
지운다. 클레임 전이므로 **지워도 잃을 데이터가 없다** — 4-8 의 회수 정책 중 유일하게 고지
없이 지울 수 있는 경우다.

### 4-3. 초대 코드

harkroom 서버 안의 `invite` 테이블(001)과 **다른 것**이다. 그쪽은 *워크스페이스 안으로 사람을
부르는* 초대고, 이쪽은 *워크스페이스를 만들 자격*이다. 이름이 같아 헷갈리므로 gate 쪽은
`workspace_grant` 로 부른다.

다만 **구현 패턴은 그대로 베낀다** — 검증된 것이 이미 있다:

| harkroom `invite` | 왜 |
|---|---|
| `token_hash text primary key` | **원문을 저장하지 않는다.** DB 가 새도 코드가 새지 않는다 |
| `used_by uuid references account(id)` | 소진 여부가 곧 사용자 기록이다 |
| `... where used_by is null for update` | **행 잠금으로 선점.** 같은 코드를 동시에 두 번 써도 하나만 통과한다 |

gate 의 `workspace_grant` 는 여기에 두 칸을 더 둔다:

- `max_workspaces int` — 한 코드로 몇 개까지. 기본 1
- `used_count int` — 소진 횟수

`for update` 를 빠뜨리면 **같은 코드로 동시에 두 요청이 들어올 때 둘 다 통과한다.** 001 이
`for update` 를 쓴 이유가 그것이고, 여기서는 그 결과가 네임스페이스 두 개다.

### 4-4. 이름 검증 — 되돌릴 수 없는 자리

서브도메인 이름은 **DNS 이름이자 k8s 네임스페이스 이름이자 git 디렉터리 이름**이 된다. 셋의
규칙이 다르므로 가장 좁은 것으로 맞춘다: `^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$` (소문자·숫자·
하이픈, 양끝은 영숫자).

**예약어를 반드시 막는다.** 안 막으면 사용자가 `app` 을 가져가 3장에서 이관한 워크스페이스와
충돌하거나, `www`·`api` 를 선점해 나중에 쓸 자리를 막는다:

```
app, www, api, admin, gate, harkroom, argocd, grafana,
mail, ns1, ns2, static, cdn, status, docs, blog
```

`gate` 자신도 목록에 있어야 한다 — gate 는 `harkroom.com` 에 있지만 누군가
`gate.harkroom.com` 을 가져가면 혼동이 생긴다.

### 4-5. 비동기 — 요청 하나로 안 끝난다

커밋 → ArgoCD 싱크 → 파드 기동 → 마이그레이션까지 **수십 초에서 수 분**이다. HTTP 응답 하나로
못 끝내므로 작업 자원을 만든다.

```
POST /api/workspaces          → 202 { jobId, name }
GET  /api/workspaces/<jobId>  → { status, message }
```

`status`: `queued` → `committed` → `syncing` → `waiting_ready` → `bootstrapping` → `ready`
(또는 `failed` + 사유).

데스크탑에는 **"만드는 중" 화면**이 생긴다. 단계 이름을 그대로 보여 주는 것으로 충분하다 —
몇 분이 걸리는 일에 스피너만 돌면 사용자는 멈춘 줄 안다.

### 4-6. 실패를 되돌린다

중간에 깨지면 반쯤 만들어진 것이 남는다. 단계별로 되돌리는 방법이 다르다.

| 실패 지점 | 남는 것 | 처리 |
|---|---|---|
| 커밋 전 | 없음 | grant 선점을 되돌린다(`used_count` 감소) |
| 커밋 후 · 싱크 실패 | git 디렉터리 | 되돌리는 커밋을 밀고 `failed` |
| 파드가 안 뜸 | 네임스페이스 | 타임아웃(10분) 뒤 되돌리는 커밋 |
| **클레임 실패** | **빈 워크스페이스** | 아래 |

마지막 줄이 다른 셋과 성격이 다르다. **gate 의 일이 아니다** — 인스턴스는 정상이고, 사용자가
`/claim` 을 아직 못 끝냈을 뿐이다. gate 는 `ready` 로 답한 시점에 자기 몫을 끝냈다.

`/claim` 자체가 중간에 깨지는 경우는 **재시도로 끝난다**: 계정과 기본 채널이 한 트랜잭션이라
(`/bootstrap` 41-50행의 그 장치를 그대로 쓴다) 계정만 남아 굳는 일이 없다. 롤백됐으면 토큰이
소진되지 않았으므로 같은 토큰으로 다시 부르면 되고, 커밋됐는데 응답만 못 받았으면 두 번째
호출이 **404**(소진된 토큰)로 답한다 — 그때는 이미 성공한 것이니 로그인하면 된다.

아무도 클레임하지 않은 채로 남는 것은 실패가 아니라 **만료**로 다룬다(4-2-4).

### 4-7. gate 자신의 권한 — 최소로

gate 는 **k8s API 를 직접 부르지 않는다.** git 에 커밋만 하고 ArgoCD 가 클러스터를 만든다
(homelab-infra 원칙 3: GitOps 가 단일 소스). gate 가 털려도 공격자가 얻는 것은 **git 푸시
권한**이고, 그것은 PR 기록으로 남는다 — 클러스터 자격증명이 아니다.

필요한 것:

| 자격 | 범위 |
|---|---|
| git 푸시 | 홈랩 GitOps 레포 **한 개**, deploy key |
| `kubeseal` 공개키 | 봉인 전용 — **복호화는 못 한다** |
| ArgoCD 상태 조회 | 읽기 전용 토큰(폴링용, 선택) |

gate 도 자기 DB 가 필요하다(grant·job). 같은 클러스터의 `harkroom-gate` 네임스페이스에 두되,
**워크스페이스 인스턴스들과 DB 를 공유하지 않는다** — 1장의 격리 원칙이 gate 에도 같이 적용된다.

### 4-8. 쿼터 — 공개 이전에 반드시

초대 코드가 지금의 방벽이지만, 코드 하나가 새면 그것으로 무한히 만들 수 있다. 미니PC 5대는
**워크스페이스 몇십 개면 찬다**(인스턴스마다 server + Postgres + PVC).

- `workspace_grant.max_workspaces` (4-3) — 코드당 상한
- 클러스터 전체 상한 — gate 가 만들기 전에 현재 개수를 세고 거부
- 네임스페이스마다 `ResourceQuota`·PVC 크기 상한
- **미사용 워크스페이스 회수 정책** — 만들고 안 쓰는 것이 쌓인다. 정책을 지금 정하지 않아도
  되지만, *"언젠가 지운다"* 를 사용자에게 **만들 때 고지**해야 나중에 지울 수 있다

### 4-9. 데스크탑 변경

작다. `ConnectScreen` 의 세 모드(`signin | bootstrap | register`)에 **`create` 를 더한다** —
이미 판별 유니온으로 갈려 있어(41행) 네 번째가 자연스럽다.

- Server URL 칸 대신 **서브도메인 이름** · 초대 코드 · **이메일**(4-2-2) 칸.
  **비밀번호는 받지 않는다**
- 제출하면 gate 에 `POST`, 4-5 의 폴링, "만드는 중" 표시
- `ready` 가 되면 `baseUrl` 을 `https://<이름>.harkroom.com` 으로 조립하고, `bootstrap` 모드와
  **같은 폼**으로 자격증명을 받아 `/claim` 을 부른다(4-2-1)
- 그 뒤는 기존 로그인 흐름 그대로다 — 그 아래는 손대지 않는다

### 4-10. 단계

gate 가 자동화할 **대상**이 먼저 검증돼야 한다. 6장의 1~7 단계(템플릿 + 두 번째 워크스페이스
수동 검증)를 마친 뒤 시작한다 — 손으로 두어 번 밟아 봐야 무엇을 커밋해야 하는지가 확정된다.

| # | 무엇 |
|---|---|
| 1 | private 레포 `harkroom-gate` 생성, grant/job 스키마 |
| 2 | 초대 코드 발급 CLI (내가 쓰는 것, UI 없음) |
| 3 | **harkroom 서버에 `POST /claim`** + 마이그레이션 054 + 레이트 리밋(4-2). 이것만 따로 PR |
| 4 | `POST /api/workspaces` — 검증·선점·이메일 저장·토큰 생성·커밋까지 |
| 5 | 상태 폴링 + ArgoCD 대기 + `ready` 응답에 클레임 토큰 |
| 6 | 되돌리기(4-6) · 만료 회수(4-2-4) · 쿼터(4-8) |
| 7 | 데스크탑 `create` 모드 + 클레임 화면 |
| 8 | 메일 발송(확인 링크·예고) + 복구 요청 접수(4-2-2) |
| 9 | 초대 코드 없이 열기 — **4-8 과 8번이 끝난 뒤에만** |

3번은 **이 저장소의 PR 이고 나머지는 gate 레포**다. 순서가 그런 이유: `/claim` 이 없으면
gate 가 만든 인스턴스를 아무도 가져갈 수 없다. 5번까지 하면 손으로 밟던 GitOps PR 절차가
사라지고, 7번부터가 사용자에게 보이는 자동화다.

## 5. 운영에서 달라지는 것

| 항목 | compose 때 | k8s 서브도메인 |
|---|---|---|
| 백업 단위 | 볼륨 두 개 | **테넌트마다** CNPG 자동 백업(붙이면) + 첨부 PVC |
| 클라이언트 IP | 전부 docker 게이트웨이(§9) | `TRUST_PROXY=1` 로 실제 IP. 감사 로그·레이트리밋이 정상 동작 |
| 버전 올리기 | `docker compose build` | `kustomization.yaml` 의 이미지 태그 → PR. 인스턴스별로 따로 올릴 수 있다 |
| 낡은 배포 확인 | `/healthz` | 같다. `MURMUR_COMMIT` 이 ghcr 빌드에서 심긴다 |

**백업이 인스턴스 수만큼 늘어난다**는 것이 가장 큰 변화다. 다만 손으로 `pg_dump` CronJob 을
만들 필요는 없다 — **CNPG 가 그 일을 한다.** `backup:` 블록(barmanObjectStore)과
`ScheduledBackup` 을 테넌트 매니페스트에 넣으면 R2 로 자동 백업 + PITR 이 된다. rowlol 이
쓰는 그대로다.

> ⚠️ **지금은 그 블록이 없다.** 테넌트 DB 는 백업이 없는 상태이고, 첨부 PVC 도 마찬가지다.
> 6장 8번이 이것이다 — 실사용자를 받기 전에 붙인다.

## 6. 순서

| # | 무엇 | 선행 |
|---|---|---|
| 1 | ~~Cloudflare `harkroom.com` 등록 + external-dns 로 apex·와일드카드 레코드~~ **완료** (homelab #115) | — |
| 2 | ~~플랫폼 스택 확인(istio·external-dns·sealed-secrets·local-path·cloudflared)~~ **완료** | 1 |
| 3 | ~~`harkroom-app/` 매니페스트 작성~~ **완료** (homelab `izagood/harkroom-app`) | 2 |
| 4 | 머지 → ArgoCD 싱크 → 파드 기동 확인. 이관 전이면 **replicas 0** 으로 내린다 | 3 |
| 5 | **기존 데이터 이관** (3장) | 4 |
| 6 | `replicas 1` → `/healthz`·첨부 확인 | 5 |
| 7 | 두 번째 워크스페이스(`harkroom-alice/`)를 복사로 만들어 검증 | 6 |
| 8 | **CNPG `backup:` 블록**(R2) — 실사용자 전에 | 7 |
| 9 | 홈랩 레포 `README.md` 갱신 — 토폴로지·앱 목록·절차 | 전부 |

9번은 선택이 아니다: homelab-infra 원칙 6 이 "코드만 바꾸고 README 를 두고 가는 것은 작업
미완료"로 규정한다.

## 7. 이 계획이 **안 하는** 것

- **앱에 멀티테넌시를 넣지 않는다.** 서브도메인 분리는 인프라에서 끝난다
- **수평 확장하지 않는다.** presence 가 인메모리라 `replicas: 1` 이 상한이다
- **cert-manager 로 인증서를 발급하지 않는다.** TLS 는 Cloudflare 엣지에서 끝난다
- **초대 코드 없이 열지 않는다.** 공개 게이트는 쿼터·회수 정책(4-8)이 선 뒤에만 연다
- **gate 가 k8s API 를 부르지 않는다.** git 에 커밋만 하고 ArgoCD 가 만든다(4-7)
- **기존 `/bootstrap` 을 바꾸지 않는다.** 셀프호스트의 Quick Start 가 그대로 선다 —
  더하는 것은 `/claim` 하나뿐이다(4-2)
- **`account` 에 이메일 컬럼을 넣지 않는다.** 이메일은 gate 의 DB 에만 있고, harkroom
  서버는 그 존재를 모른 채로 남는다(4-2-2). 서버가 메일을 보내는 일도 없다
- **avcs 서버를 옮기지 않는다.** 별도 프로세스이고 자기 절차를 따른다
