import { Fragment, useMemo, type ReactNode } from 'react';
import { useT } from '../i18n/useT';
import { useActiveStore } from '../state/communities';
import { NO_TEAMS } from '../state/appStore';
import { splitMentions } from '../lib/mention';
import { splitLinks, type LinkTarget, type BodyPart } from '../lib/link';
import { extractPreviewUrls, renderMentions } from '@murmur/shared';
import { splitCode } from '../lib/code';
import { parseBlocks, type Align, type Block, type Emphasis, type Inline } from '../lib/markdown';
import { getExternalOpener } from '../lib/openExternal';
import { accountOpen } from '../lib/accountOpen';
import { getController } from '../state/controller';
import { LinkPreview } from './LinkPreview';
import type { SectionId } from './settings/sections';

/**
 * 본문을 그리면서 멘션만 강조한다. 존재하는 handle 만 칠한다 — 오타를 멘션처럼 보여 주면
 * 사용자는 알림이 갔다고 착각한다.
 *
 * 그 위에 링크 인식을 얹는다(#214). 링크가 되는 것은 `classifyLink` 가 허용한 것뿐이고,
 * 나머지 스킴은 막히는 것이 아니라 **애초에 누를 것이 생기지 않는다**.
 *
 * 그 앞에 코드가 온다(#216). 코드가 먼저 나뉘므로 코드 안의 URL 과 @handle 은 링크도
 * 멘션도 되지 않는다 — 별도 예외 처리가 아니라 순서에서 따라오는 결과다.
 *
 * 코드와 멘션 사이에 마크다운 구조가 들어간다(#216). 제목·목록·인용·강조는 `lib/markdown`
 * 이 **구조체**로 읽어 오고 여기서는 그것을 엘리먼트로만 바꾼다 — 이 파일에
 * `dangerouslySetInnerHTML` 이 없는 것이 계약이다. 마크다운이 코드 뒤·멘션 앞에 오는
 * 덕분에 "코드 블록 안의 `**` 는 굵어지지 않고, 굵은 글씨 안의 `@handle` 은 멘션으로
 * 남는다" 가 예외 처리 없이 따라온다.
 *
 * 길다고 접지 않는다. 접기는 한때 있었지만(#217) 실제로는 거의 모든 메시지가 문턱을
 * 넘어 늘 "Show more" 가 달렸고, 읽으려면 매번 눌러야 했다 — 스크롤 한 번으로 끝날 일에
 * 클릭을 더한 셈이라 걷어냈다. 본문은 언제나 통째로 보인다.
 */

/**
 * 링크를 누르면 어디로 가는가. `murmur://` 는 OS 를 거치지 않고 앱 안에서 이동한다 —
 * murmur 를 모르는 OS 로 보내면 아무 일도 일어나지 않는다.
 *
 * 여는 데 실패하면 반드시 사람에게 보인다. 조용히 삼키면 사람은 앱이 멈춘 것으로 본다.
 * (`openMessage` 는 자기 실패를 스스로 알린다 — 사유마다 다음에 할 일이 다르기 때문이다.)
 */
async function followLink(target: LinkTarget): Promise<void> {
  if (target.kind === 'message') {
    await getController().openMessage(target.messageId);
    return;
  }
  try {
    await getExternalOpener().open(target.href);
  } catch {
    useActiveStore.getState().set({
      notice: `Could not open ${target.href} — no browser answered. Copy the link and open it yourself.`,
    });
  }
}

/**
 * 멘션을 눌렀을 때 갈 곳(#279). 두 신호를 **옵셔널**로 두는 이유와 그 위험을 함께 적는다:
 * 이 컴포넌트는 채널 문서 패널처럼 이동이 없는 자리에서도 쓰이고, 단위 테스트가 본문만
 * 띄우기도 한다. 대신 옵셔널이 **조용히 죽은 버튼을 만드는 것**은 막는다 — 신호가 없으면
 * 버튼을 아예 그리지 않는다(아래 `openable`). 배선이 끊긴 채로 눌러도 아무 일이 없는
 * 컨트롤을 남기는 것이 옵셔널의 진짜 위험이고, 실제로 이 브랜치의 초판이 그랬다:
 * `Workspace` 가 `ChannelPane` 에 두 신호를 넘기지 않아 앱에서 모든 멘션이 죽은 버튼이었다.
 * 그 배선은 `test/mentionClick.test.tsx` 가 `Workspace` 를 통째로 띄워 지킨다.
 */
interface MentionOpeners {
  onOpenDirectory?: (accountId: string | null) => void;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
}

export function MessageBody({
  body,
  messageId,
  refIds,
  onOpenDirectory,
  onOpenSettings,
}: {
  body: string;
  messageId: string;
  /**
   * 본문이 이름으로 **지칭만 한** 계정 id 들(`meta.mentionRefs`). 서버가 알림을 만들면서
   * 함께 적어 준 값이고, 화면은 그것을 **다시 판정하지 않는다** — `mentionChainCapped` 와
   * 같은 규율이다(`MessageItem` 의 같은 자리 주석). 본문 글자로 다시 가르면 서버가 실제로
   * 부른 곳과 화면이 부른 것처럼 그리는 곳이 갈라진다.
   */
  refIds?: readonly string[];
} & MentionOpeners) {
  const t = useT();
  const accounts = useActiveStore((s) => s.accounts);
  const groups = useActiveStore((s) => s.groups);
  // 목록을 못 받은 서버에서는 빈 목록이 사실이다 — 판단의 근거는 `Composer` 의 같은
  // 자리 주석과 하나다(그 서버는 `@팀` 을 펼치지 않으므로 칠할 이름이 없다).
  const teams = useActiveStore((s) => s.teams) ?? NO_TEAMS;
  const me = useActiveStore((s) => s.me);
  const myHandle = me?.handle?.toLowerCase() ?? null;
  // `accountOpen` 은 순수 함수라 스토어를 모른다 — 지금 보고 있는 사람을 값으로 준다.
  const viewer = useMemo(() => ({ id: me?.id ?? null, isAdmin: me?.isAdmin === true }), [me?.id, me?.isAdmin]);
  // 코드 → 마크다운 구조 순서로 읽는다(#216). 이 순서가 곧 규칙이다 — `lib/markdown` 참고.
  const blocks = useMemo(() => parseBlocks(splitCode(body)), [body]);
  const handles = useMemo(() => Object.values(accounts).map((a) => a.handle), [accounts]);
  const accountsMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of Object.values(accounts)) {
      map.set(a.id, a.handle);
    }
    return map;
  }, [accounts]);
  /**
   * `splitMentions` 이 "여럿을 부르는 이름" 으로 칠할 목록 — 집합과 팀(#172)을 함께 준다.
   *
   * 팀을 빼면 이 파일 머리의 경계가 깨진다: *"강조되지 않은 것이 몰래 알림을 보낸다"*.
   * 서버는 `@release` 를 팀으로 펼쳐 다섯을 깨우는데(`services/messages.ts`) 화면은
   * 평범한 글자로 그리고, 그러면 읽는 사람은 그 발화가 아무도 부르지 않았다고 읽는다.
   */
  const groupHandles = useMemo(
    () => [...groups.map((g) => g.handle), ...teams.map((t) => t.name)],
    [groups, teams],
  );
  // 미리보기 대상 URL(#215). **서버와 같은 함수**를 쓴다 — 각자 정규식을 두면 서버가
  // 저장한 키와 여기서 조회하는 키가 갈라져 카드가 영원히 404 다(초판이 그랬다: 여기는
  // 후행 문장부호를 떼지 않아 `…/b.` 로 조회했다).
  const urls = useMemo(() => extractPreviewUrls(body), [body]);
  /**
   * 지칭된 handle 들. id 로 받아 **여기서** handle 로 바꾼다 — 서버가 handle 이 아니라 id 를
   * 싣는 이유가 이것이다(그 사이 이름이 바뀌어도 본문의 칩과 같은 값으로 맞춰진다).
   */
  const refHandles = useMemo(() => {
    const out = new Set<string>();
    for (const id of refIds ?? []) {
      const handle = accountsMap.get(id);
      if (handle) out.add(handle.toLowerCase());
    }
    return out;
  }, [refIds, accountsMap]);
  // handle → 계정. 멘션마다 `Object.values(...).find` 를 돌면 본문 하나에 계정 수 × 멘션 수다.
  const byHandle = useMemo(
    () => new Map(Object.values(accounts).map((a) => [a.handle.toLowerCase(), a])),
    [accounts],
  );

  /**
   * 누를 수 있는 링크. 맨 URL(#214)과 `[글자](주소)`(#216)가 **같은 여기 하나**를 지난다 —
   * 이동 경로가 신뢰 경계라서(외부 셸로 나가는 자리다) 두 벌로 두면 한쪽만 고쳐진다.
   */
  const anchor = (label: string, href: string, target: LinkTarget, key: string) => (
    <a
      key={key}
      // href 를 두는 이유: 마우스를 올리면 어디로 가는지 보이고 키보드로도 잡힌다.
      // 실제 이동은 우리가 한다 — 웹뷰가 스스로 따라가면 앱이 그 페이지로 바뀐다.
      href={href}
      rel="noreferrer noopener"
      data-testid="body-link"
      data-link-kind={target.kind}
      className="text-accent underline underline-offset-2 hover:text-accent-hover"
      onClick={(e) => { e.preventDefault(); void followLink(target); }}
    >
      {label}
    </a>
  );

  /** 코드가 아닌 구간만 멘션·링크 조각으로 나눠 그린다. */
  const renderPart = (p: BodyPart, key: string) => {
    if (p.kind === 'text') return <span key={key}>{p.text}</span>;
    if (p.kind === 'link') return anchor(p.text, p.text, p.target, key);
    const isGroup = (p as { isGroup?: boolean }).isGroup === true;
    // 지칭은 **자기 멘션보다 먼저 본다.** 나를 지칭했을 뿐인 이름에 주의색을 칠하면 내
    // 차례가 아닌데 내 차례처럼 보인다 — 이 변경이 없애려는 바로 그 거짓말이다.
    const isRef = !isGroup && refHandles.has(p.handle);
    const isSelf = !isRef && p.handle === myHandle;
    const account = byHandle.get(p.handle);

    // 어디로 가는가(#279). `null` 이면 누를 것이 없다.
    //
    // 계정이 없는 멘션(`@channel`)과 집합(#230)은 **갈 곳이 없다.** 디렉터리는 계정의 표라서
    // 집합의 행이 없고, 없는 계정으로 열면 아무 행도 강조되지 않는다. 강조되지 않는
    // 오타(`@없는이름`)가 애초에 여기 오지 않는 것과 같은 이유다: 누를 수 있게 만들면
    // "여기에 뭔가 있다" 는 거짓을 말하게 된다.
    //
    // 에이전트를 어디로 보낼지(admin·소유자면 설정, 그 외는 디렉터리)와 접근 가능한 이름은
    // **`lib/accountOpen` 한 곳**에서 나온다. 여기 인라인으로 있던 것을 옮긴 이유는 그
    // 파일 머리에 적었다 — 이름줄·아바타(`MessageItem`)가 같은 곳으로 가야 해서, 그대로
    // 두면 같은 조건문이 두 벌이 된다.
    const open = isGroup ? null : accountOpen(account, viewer, { onOpenDirectory, onOpenSettings }, t);
    const target = open?.run ?? null;
    const accessibleName = open?.label;

    /**
     * **멘션 칩은 배경과 굵기로 구별한다 — 색이 아니다**(#488 B2).
     *
     * 문서: *"본문에 여러 번 나오는 것은 색이 아니라 옅은 배경으로 구별한다."*
     * 남을 부른 멘션까지 강조색을 쓰면 한 화면에 강조가 열 개씩 서고, 그러면 정작
     * **나를 막는 말**에 색을 칠해도 눈에 띄지 않는다(규칙 04).
     *
     * 나를 부른 것은 그대로 주의색을 받는다 — 그것은 실제로 내 차례를 만든다.
     * 집합은 다른 색(teal)으로 구분한다.
     */
    const className = `rounded px-0.5 font-medium ${
      isGroup
        ? 'bg-teal-50 text-teal-700'
        : isRef
          // **지칭에는 배경이 없다.** 옅은 배경이 곧 "부른 이름"이라는 표시이므로, 부르지
          // 않은 이름에 그것을 칠하면 화면이 없던 호출을 있다고 말한다(design.md §4).
          // 이름인 것은 여전히 보여야 하니 굵기는 남기고, 눌러서 프로필로 가는 것도 그대로다.
          ? 'text-fg'
          : isSelf
            ? 'bg-warning-surface-strong text-warning'
            : 'bg-surface-sunken text-fg'
    }`;
    // 표시는 한 곳에서 나온다 — 누를 수 있는 것과 없는 것을 따로 그리면 색·배지가 갈라진다.
    const shared = {
      'data-testid': `mention-${p.handle}`,
      'data-self': String(isSelf),
      'data-group': String(isGroup),
      // 부른 것인가. 회귀선은 색이 아니라 이 값을 본다 — 색은 디자인이 바꾸는 것이고
      // "불렀는가"는 바뀌면 안 되는 사실이다.
      'data-call': String(!isRef),
      className,
    };

    // 갈 곳이 없으면 **버튼이 아니다.** 눌러도 아무 일이 없는 컨트롤은 없는 것보다 나쁘다.
    if (!target) return <span key={key} {...shared}>{p.text}</span>;

    return (
      <button
        key={key}
        type="button"
        {...shared}
        className={`${className} cursor-pointer`}
        aria-label={accessibleName}
        onClick={target}
      >
        {p.text}
      </button>
    );
  };

  /**
   * 강조를 겉에 씌운다. `<strong>`·`<em>`·`<s>` 는 **의미가 있는 태그**다 — 굵기만 필요하면
   * `font-bold` 로 끝나지만 그러면 스크린리더에 아무것도 전달되지 않는다. 세 축이 독립이라
   * 중첩(`**굵고 _기울고_**`)이 그대로 태그 중첩으로 나온다.
   */
  const withEmphasis = (node: ReactNode, e: Emphasis, key: string): ReactNode => {
    let out = node;
    if (e.strike) out = <s data-testid="md-strike">{out}</s>;
    if (e.em) out = <em data-testid="md-em">{out}</em>;
    if (e.strong) out = <strong className="font-semibold" data-testid="md-strong">{out}</strong>;
    return <Fragment key={key}>{out}</Fragment>;
  };

  /** 인라인 코드. 코드 블록과 같은 배경을 쓴다 — "이건 그대로 복사할 것" 이라는 같은 신호다. */
  const codeSpan = (code: string, key: string) => (
    <code
      key={key}
      data-testid="inline-code"
      className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[0.9em] text-fg"
    >
      {code}
    </code>
  );

  /**
   * 인용 안의 글자. 토큰만 지금 handle 로 바꾸고 그 밖은 손대지 않는다.
   *
   * `accountsMap` 이 비었으면 그대로 둔다 — `splitMentions` 이 같은 조건에서 같은 선택을
   * 한다(#271). 여기만 다르게 굴면, 계정을 아직 못 받은 화면에서 인용은 `@알 수 없음`,
   * 인용 밖은 `<@id>` 로 갈라진다.
   */
  const quotedText = (text: string): string =>
    accountsMap.size > 0 ? renderMentions(text, accountsMap) : text;

  /**
   * 마크다운이 읽은 조각 하나. **글자 조각만** 멘션·링크 인식을 한 번 더 지난다 —
   * 코드와 `[글자](주소)` 는 이미 확정된 것이라 다시 나누면 안 된다.
   */
  const renderInline = (span: Inline, key: string, quoted = false): ReactNode => {
    if (span.kind === 'code') return codeSpan(span.code, key);
    if (span.kind === 'link') {
      return withEmphasis(anchor(span.text, span.href, span.target, `${key}-a`), span, key);
    }
    // 인용 안에서는 멘션을 칠하지 않는다(#592). 서버가 인용 줄의 `@handle` 을 부르지
    // 않으므로, 여기서 칠하면 화면이 "불렀다" 고 거짓말을 한다 — 이 파일이 코드 구간에서
    // 이미 피하고 있는 그 거짓말이다. 링크는 인용 안에서도 링크다(부르는 것이 아니다).
    //
    // 다만 `<@id>` 토큰은 **읽어 준다**(#271). 인용이 끄는 것은 "부르는 것" 하나이고,
    // 토큰 해석까지 같이 끄면 옮겨 적은 말 자체가 깨진다 — 정본이 `<@id>` 이므로 앞
    // 메시지 본문을 그대로 인용하면 날 uuid 가 화면에 드러난다(에이전트가 저장된 본문을
    // 옮겨 적을 때 실제로 그렇게 된다). 읽되 칠하지 않는 것이 인용의 규칙이다.
    const parts = quoted
      ? splitLinks([{ kind: 'text', text: quotedText(span.text) }])
      : splitLinks(splitMentions(span.text, handles, groupHandles, accountsMap));
    return withEmphasis(parts.map((p, j) => renderPart(p, `${key}-${j}`)), span, key);
  };

  const renderSpans = (spans: Inline[], key: string, quoted = false) =>
    spans.map((s, i) => renderInline(s, `${key}-${i}`, quoted));

  /**
   * 블록 하나. 간격을 `space-y` 가 아니라 블록마다의 `mb-*`/`last:mb-0` 으로 주는 이유:
   * 제목은 **위쪽** 간격이 더 필요하고(다음 절이 시작한다는 신호다) 컨테이너 하나의
   * 균일 간격으로는 그 차이를 낼 수 없다.
   */
  const renderBlock = (block: Block, key: string): ReactNode => {
    switch (block.kind) {
      case 'heading': {
        // 실제 `<h1>` 을 쓰지 않는다. 메시지는 대화 목록 **안**에 있어서 문서 개요의
        // 자리를 주장하면 안 되고, 한 채널에 `<h1>` 이 스무 개 서면 개요가 거짓이 된다.
        // 대신 `role=heading` + `aria-level` 로 **상대적** 깊이만 말한다.
        const size = block.level <= 1 ? 'text-[1.15em]' : block.level === 2 ? 'text-[1.05em]' : 'text-[1em]';
        return (
          <div
            key={key}
            role="heading"
            aria-level={Math.min(6, block.level + 2)}
            data-testid="md-heading"
            data-level={block.level}
            className={`mt-3 mb-1 font-semibold text-fg first:mt-0 ${size}`}
          >
            {renderSpans(block.spans, key)}
          </div>
        );
      }
      case 'quote':
        return (
          <blockquote
            key={key}
            data-testid="md-quote"
            className="mb-2 border-l-2 border-border pl-2 text-fg-muted last:mb-0"
          >
            {renderSpans(block.spans, key, true)}
          </blockquote>
        );
      case 'rule':
        return <hr key={key} data-testid="md-rule" className="my-2.5 border-border" />;
      case 'list': {
        const Tag = block.ordered ? 'ol' : 'ul';
        return (
          <Tag
            key={key}
            data-testid="md-list"
            data-ordered={String(block.ordered)}
            // `list-outside` + 왼쪽 여백: 감긴 둘째 줄이 글머리표 아래로 흘러들지 않는다.
            start={block.ordered ? block.start : undefined}
            className={`mb-2 ml-5 list-outside last:mb-0 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
          >
            {block.items.map((item, i) => (
              <li key={i} data-testid="md-list-item" className="my-0.5">
                {renderSpans(item.spans, `${key}-${i}`)}
                {item.children.map((c, j) => renderBlock(c, `${key}-${i}-${j}`))}
              </li>
            ))}
          </Tag>
        );
      }
      case 'table': {
        // 정렬은 구분줄이 말한 것만 따른다. `null` 은 왼쪽이다 — 칸 내용을 보고 숫자면
        // 오른쪽으로 미루는 추측을 하지 않는다(`lib/markdown` 의 `Align` 참고).
        const cell = (a: Align) =>
          a === 'center' ? 'text-center' : a === 'right' ? 'text-right' : 'text-left';
        return (
          // 넓은 표는 **가로로 스크롤한다.** 대화 폭에 맞추려고 열을 접으면 같은 열이
          // 행마다 다른 자리에 서고, 그때 표는 표가 아니게 된다. 코드 블록과 같은 선택이다.
          <div key={key} className="my-2 overflow-x-auto last:mb-0">
            <table
              data-testid="md-table"
              data-cols={String(block.align.length)}
              className="min-w-full border-collapse text-[0.95em]"
            >
              <thead>
                <tr>
                  {block.head.map((c, ci) => (
                    <th
                      key={ci}
                      // `scope` 를 두는 이유: 스크린리더가 각 칸을 읽을 때 어느 열인지
                      // 함께 말해 준다. 굵게만 칠하면 그 연결이 전달되지 않는다.
                      scope="col"
                      className={`border border-border bg-surface-sunken px-2 py-1 font-semibold whitespace-normal ${cell(block.align[ci] ?? null)}`}
                    >
                      {renderSpans(c, `${key}-h-${ci}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, ri) => (
                  <tr key={ri} data-testid="md-table-row">
                    {row.map((c, ci) => (
                      <td
                        key={ci}
                        // 칸 안에서는 `pre-wrap` 을 끈다. 칸은 이미 앞뒤 여백을 떼고 왔고,
                        // 여기서 여백을 그대로 지키면 표 폭이 글자 수가 아니라 사람이 칸을
                        // 맞추려고 넣은 공백으로 결정된다.
                        className={`border border-border px-2 py-1 align-top whitespace-normal ${cell(block.align[ci] ?? null)}`}
                      >
                        {renderSpans(c, `${key}-${ri}-${ci}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      case 'code':
        return (
          // 코드는 접히지 않는다 — 줄바꿈된 명령줄은 그대로 복사해도 실행되지 않는다.
          // 대신 가로로 스크롤한다.
          <div key={key} className="my-2 overflow-hidden rounded border border-border last:mb-0">
            {block.lang && (
              // 언어는 **표시만** 한다. 문법 강조기를 들이면 의존성과 공격 표면이 같이 커진다.
              <div
                data-testid="code-lang"
                className="border-b border-border bg-surface-sunken px-2 py-0.5 font-mono text-[0.75em] text-fg-subtle"
              >
                {block.lang}
              </div>
            )}
            <pre
              data-testid="code-block"
              data-lang={block.lang ?? ''}
              className="overflow-x-auto bg-surface px-2 py-1 font-mono text-[0.9em] text-fg"
            >
              <code>{block.code}</code>
            </pre>
          </div>
        );
      default:
        return (
          <p key={key} data-testid="md-paragraph" className="mb-2 last:mb-0">
            {renderSpans(block.spans, key)}
          </p>
        );
    }
  };

  const bodyContent = (
    // `whitespace-pre-wrap` 은 여기 그대로 둔다 — 문단 안의 한 줄바꿈은 마크다운에서는
    // 사라지는 것이 표준이지만, 채팅에서 줄을 나눠 쓴 사람은 **그렇게 보이기를 기대한다.**
    // 문법을 따르느라 사람이 쓴 줄바꿈을 지우면 렌더링이 내용을 바꾼 것이 된다.
    <div className="whitespace-pre-wrap break-words" data-testid="message-body">
      {blocks.map((b, i) => renderBlock(b, String(i)))}
    </div>
  );

  const linkPreviews = urls.map((url) => <LinkPreview key={url} url={url} />);

  return (
    <>
      {bodyContent}
      {linkPreviews}
    </>
  );
}
