# @murmur/agent

murmur 에이전트 러너. 멘션을 기다리다 깨어나 답하는 **상주 프로세스**다.

이것이 있어야 murmur가 "사람과 에이전트가 함께 일하는 워크스페이스"가 된다. 서버의 MCP 표면
(`/mcp`)만으로는 에이전트가 *호출될 수* 있을 뿐, `@handle`을 불렀을 때 *찾아오지* 않는다 —
Claude Code나 Cursor는 사람이 프롬프트할 때만 움직이기 때문이다. 이 러너가 그 자리를 채운다.

## 실행

```sh
# 1) 에이전트 계정과 PAT (admin 토큰으로)
curl -X POST localhost:3400/accounts/agents -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"handle":"rusalka","displayName":"Rusalka"}'
curl -X POST localhost:3400/accounts/<id>/pats -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"label":"runner"}'

# 2) 러너 기동
MURMUR_PAT=murp_... ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @murmur/agent start
```

이제 murmur에서 `@rusalka 이거 봐줘`라고 쓰면 답이 온다.

| 환경변수 | 기본값 | 뜻 |
|---|---|---|
| `MURMUR_PAT` | (필수) | 에이전트 PAT. 이 계정으로 발화한다 |
| `ANTHROPIC_API_KEY` | (SDK가 읽음) | 없으면 `ant auth login` 프로필도 쓰인다 |
| `MURMUR_URL` | `http://localhost:3400` | murmur 서버 |
| `AGENT_MODEL` | `claude-opus-5` | |
| `AGENT_EFFORT` | `medium` | `low`~`max`. 채팅 응답은 낮은 쪽이 낫다 |
| `AGENT_POLL_TIMEOUT_MS` | `25000` | 서버의 `inbox.poll` 상한 |

## Claude Code · Cursor에 붙이기 (러너와 별개)

러너 없이 **사람이 운전하는** 에이전트로 쓸 수도 있다. 이쪽은 murmur를 MCP 서버로 등록하는 것이다:

```sh
claude mcp add --transport http murmur http://localhost:3400/mcp \
  --header "Authorization: Bearer murp_..."
```

`claude mcp list`에 `✔ Connected`가 뜨면 Claude Code가 murmur의 도구 9종을 쓸 수 있다.
차이는 이렇다 — **등록은 사람이 부를 때만 움직이고, 러너는 멘션에 스스로 깨어난다.** 둘은 함께 쓸 수 있다.

## 왜 MCP인가

스펙(`docs/design.md` §4)이 지정한 에이전트 표면이 MCP다. 실질적 이유도 있다: inbox 롱폴이
MCP `inbox.poll`에만 있고 REST `/inbox`에는 없다. 이 러너를 만들면서 MCP 표면에 구멍이
드러났다 — 미읽음을 **소비**하는 도구가 없어 같은 멘션에 영원히 반복 응답했다. `inbox.read`를
추가해 닫았고, 그래서 러너는 REST를 전혀 쓰지 않는다.

## poll 루프 계약

서버가 재시작되면 진행 중인 poll이 **빈 결과로 정상 마감**되거나 **transport 오류**로 끊긴다.
둘 다 정상이며 재접속 + 지수 백오프(최대 30초)로 대응한다. 답변 실패는 읽음 처리하지 않으므로
다음 폴에서 다시 시도된다 — 한 건의 실패가 루프를 죽이지 않는다.

## 구조

| 파일 | 역할 |
|---|---|
| `src/reply.ts` | 멘션 → 요청 변환, 응답 → 발화문 추출. **순수 로직이고 테스트 대상이다** |
| `src/murmur.ts` | MCP 클라이언트 (`account.me` `workspace.guide` `channel.list` `message.read` `message.post` `inbox.poll` `inbox.read`) |
| `src/config.ts` | 환경변수 |
| `src/main.ts` | 루프 조립 |

`reply.ts`가 순수한 덕분에 API 키 없이도 프롬프트 구성·역할 매핑·본문 절단·안전 거부 처리를
검증할 수 있다. 모델 호출 한 줄만 키가 필요하다.
