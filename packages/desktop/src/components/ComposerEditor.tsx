import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { EditorState, Prec, Transaction, type Extension, type Range } from '@codemirror/state';
import {
  Decoration, EditorView, ViewPlugin, keymap, placeholder as cmPlaceholder,
  type DecorationSet, type ViewUpdate,
} from '@codemirror/view';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { Strikethrough } from '@lezer/markdown';
import { tags } from '@lezer/highlight';
import { clean } from '../lib/systemText';
import { focusKind, recordEnter } from '../lib/enterTrace';

/**
 * 입력창 편집기(입력창 개편 P1, 결정 1 = CodeMirror 6).
 *
 * ## 원문은 마크다운 그대로다
 *
 * 문서는 **문자열 하나**이고 서식은 그 위에 입힌 장식이다. 그래서 쓴 글 = 보낸 글 = 에이전트가
 * 읽는 글이다. 멘션 후보·예약·보냄 취소·붙여넣기는 모두 그 문자열과 커서 위치에 서 있으므로
 * (`Composer.tsx`), 이 편집기는 그쪽에 **textarea 와 같은 손잡이**(`ComposerTextBox`)를 준다 —
 * 값·선택 범위·`setSelectionRange`·`focus`. 그 위의 기능은 편집기가 바뀐 줄 모른다.
 *
 * ## 기호는 커서가 닿은 구간에서만 보인다 (결정 2)
 *
 * `**굵게**` 의 `**` 는 커서가 그 굵은 구간 밖에 있으면 숨기고, 안에 들어오면 옅게 보인다.
 * 숨긴 기호도 문서에는 남아 있다 — 지우거나 고치려면 커서를 그 구간에 넣으면 된다.
 */

/**
 * 입력칸 상자 값(모서리·테두리 자리·여백·줄높이). 편집기 둘레 칸과 맞추려고 한 곳에 둔다.
 */
export const COMPOSER_BOX = 'rounded-compose border px-3 py-2.5 leading-relaxed';

/** textarea 를 흉내 내는 손잡이 — `Composer` 의 옛 `ref.current` 자리에 그대로 들어간다. */
export interface ComposerTextBox {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setSelectionRange(start: number, end: number): void;
  focus(): void;
}

/** 열쇠 처리기에 넘기는 것. React 의 KeyboardEvent 에서 `Composer` 가 쓰던 부분만 있다. */
export interface ComposerKeyEvent {
  key: string;
  code: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  /** CodeMirror 가 조합 중이라고 보는가(`view.composing`) — Enter 기록(`lib/enterTrace`)용. */
  editorComposing: boolean;
  preventDefault(): void;
  currentTarget: ComposerTextBox;
}

export interface ComposerPasteEvent {
  clipboardData: DataTransfer;
  preventDefault(): void;
  currentTarget: ComposerTextBox;
}

interface Props {
  value: string;
  /**
   * 초안의 자리(채널·스레드). 바뀌면 되돌리기 기록을 버린다 — 편집기는 자리를 옮겨도 다시 만들어지지
   * 않으므로, 기록을 이어 두면 B 에서 ⌘Z 를 눌렀을 때 A(DM 일 수 있다)의 초안이 돌아와 B 로 나갈 수 있다.
   */
  historyKey?: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** 보이는 최소 줄 수. 내용이 늘면 `maxHeight` 까지 자란다(결정 8). */
  rows?: number;
  ariaExpanded?: boolean;
  ariaControls?: string;
  ariaActiveDescendant?: string;
  className?: string;
  onChange(value: string, caret: number): void;
  onSelect?(value: string, caret: number): void;
  onKeyDown?(e: ComposerKeyEvent): void;
  onPaste?(e: ComposerPasteEvent): void;
}

const mdHighlight = HighlightStyle.define([
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  /*
    취소선은 인라인 스타일(`textDecoration`)이 아니라 클래스로 칠한다. WKWebView 에서 `HighlightStyle` 이 만든
    `text-decoration: line-through` 는 계산값에는 서는데 줄이 그려지지 않았다(탐침, 10-21) — 길이·색·굵기를
    다 적은 규칙(`.cm-md-strike`, index.css)은 그려진다.
  */
  { tag: tags.strikethrough, class: 'cm-md-strike' },
  { tag: tags.link, class: 'cm-md-link' },
  { tag: tags.url, class: 'cm-md-url' },
  { tag: tags.monospace, class: 'cm-md-code' },
  // 기호(`**`·`` ` ``·`>`)는 여기서 칠하지 않는다 — `liveMarks` 가 숨기거나 옅게 한다. 둘 다 칠하면 옅음이 겹친다.
]);

/** 숨기거나 옅게 보일 기호 노드. 이름은 `@lezer/markdown` 의 것이다. */
const MARK_NODES = new Set(['EmphasisMark', 'CodeMark', 'StrikethroughMark', 'LinkMark', 'QuoteMark', 'ListMark']);
/** 기호를 품은 구간 노드. 커서가 이 구간에 닿으면 기호를 보인다. */
const SPAN_NODES = new Set(['StrongEmphasis', 'Emphasis', 'Strikethrough', 'InlineCode', 'Link', 'Blockquote']);

/**
 * 조합이 끝난 뒤 Enter 를 우리가 먼저 받는 창(ms). CodeMirror 가 키를 버리는 창(100ms)보다 넉넉하다 — 아래 `onRawKey` 주석.
 */
const AFTER_COMPOSITION_MS = 300;

const hiddenMark = Decoration.replace({});
const faintMark = Decoration.mark({ class: 'cm-md-mark' });
const codeLine = Decoration.line({ class: 'cm-md-codeblock' });
/** 인용 줄의 왼쪽 2px 선(designer n1) — 보낸 메시지의 `<blockquote>`(border-l-2 pl-2)와 같은 모양이다. */
const quoteLine = Decoration.line({ class: 'cm-md-quoteline' });

function touches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

function buildMarks(view: EditorView): DecorationSet {
  const { state } = view;
  const items: Range<Decoration>[] = [];
  // 줄 장식은 한 줄에 하나 — 겹친 인용(`> > `)이 같은 줄에 선을 두 번 긋지 않게 한다.
  const lined = new Set<number>();
  const eachLine = (from: number, to: number, deco: Decoration) => {
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos);
      if (!lined.has(line.from)) {
        lined.add(line.from);
        items.push(deco.range(line.from));
      }
      pos = line.to + 1;
    }
  };
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        if (node.name === 'FencedCode') {
          eachLine(node.from, node.to, codeLine);
          return;
        }
        /*
          선은 `>` 로 시작하는 줄에만 긋는다 — 마크다운은 인용 바로 뒤의 평문 줄도 인용에 이어 붙이지만
          (게으른 이음), 보낸 메시지(`MessageBody`)는 `>` 줄만 인용으로 그린다. 쓸 때와 보낸 뒤가 같아야 한다.
        */
        if (node.name === 'QuoteMark') eachLine(node.from, node.from, quoteLine);
        /*
          링크 이름에 주소를 title 로 단다(security n2) — 주소를 숨긴 채 이름만 보이면 보내기 전에
          「보이는 이름 ≠ 실제 주소」를 확인할 길이 없다. 보낸 메시지의 링크와 같이 hover 로 보인다.
        */
        if (node.name === 'Link') {
          const url = node.node.getChild('URL');
          if (url) {
            // 방향 바꿈·제어 문자는 지운다(#1431 security n1) — 그대로 두면 주소 안의 RLO 가 마우스 올림 글을 뒤집어 보인다.
            const title = clean(state.doc.sliceString(url.from, url.to));
            items.push(Decoration.mark({ attributes: { title } }).range(node.from, node.to));
          }
        }
        /*
          링크의 주소도 기호처럼 다룬다 — 커서가 링크 밖이면 `[이름](주소)` 가 「이름」만 남는다.
          주소만 남기면 「이름https://…」 처럼 붙어 보여서 링크가 오히려 읽기 어렵다.
        */
        const isLinkUrl = node.name === 'URL' && node.node.parent?.name === 'Link';
        if (!MARK_NODES.has(node.name) && !isLinkUrl) return;
        // 목록 기호(`- `·`1. `)는 늘 보인다 — 숨기면 목록인지 알 수 없다. 옅게만 한다.
        if (node.name === 'ListMark') {
          items.push(faintMark.range(node.from, node.to));
          return;
        }
        const parent = node.node.parent;
        const span = parent && SPAN_NODES.has(parent.name) ? parent : null;
        /*
          인용 기호는 그 줄에 커서가 있을 때 보인다(인용 구간 전체가 아니라). 둘째 줄부터의 `>` 는
          부모가 Blockquote 가 아니라 그 안의 문단이라, 부모로 가르지 않고 이름으로 가른다.
        */
        const show = node.name === 'QuoteMark'
          ? touches(state, state.doc.lineAt(node.from).from, state.doc.lineAt(node.from).to)
          : span ? touches(state, span.from, span.to) : true;
        if (show) {
          items.push(faintMark.range(node.from, node.to));
          return;
        }
        // 숨긴 인용 기호는 뒤 공백까지 숨긴다 — 선이 인용을 알리니 `> ` 의 빈칸이 글을 한 칸 밀 이유가 없다.
        const end = node.name === 'QuoteMark' && state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
        items.push(hiddenMark.range(node.from, end));
      },
    });
  }
  // 줄 장식·범위 장식이 섞이고 범위가 겹친다(링크 title 이 숨긴 기호를 품는다) — 정렬은 CM6 에 맡긴다.
  return Decoration.set(items, true);
}

const liveMarks = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = buildMarks(view); }
  update(u: ViewUpdate) {
    /*
      **조합 중에는 장식을 다시 짜지 않는다.** 조합 중인 글자 둘레의 DOM 을 장식이 바꾸면
      입력기가 붙잡고 있던 자리를 잃어 글자가 튀거나 두 번 들어간다(CM6 도 조합 둘레를
      보호하지만, 기호를 숨기고 보이는 것은 바로 그 자리의 글자 수를 바꾼다).
    */
    if (u.view.composing) return;
    if (u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
      this.decorations = buildMarks(u.view);
    }
  }
}, { decorations: (v) => v.decorations });

export const ComposerEditor = forwardRef<ComposerTextBox, Props>(function ComposerEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 처리기는 렌더마다 바뀐다 — 편집기는 한 번만 만들므로 최신 것을 ref 로 본다.
  const latest = useRef(props);
  latest.current = props;
  // 바깥에서 값을 넣는 중에는 onChange 를 되돌려 보내지 않는다(제어 값의 메아리).
  const syncing = useRef(false);
  // 편집기를 만든 확장 묶음. 자리가 바뀌어 상태를 새로 짤 때(`historyKey`) 같은 것을 다시 쓴다.
  const extRef = useRef<Extension[]>([]);
  const lastHistoryKey = useRef(props.historyKey);

  const box = useRef<ComposerTextBox>({
    get value() { return viewRef.current?.state.doc.toString() ?? ''; },
    get selectionStart() { return viewRef.current?.state.selection.main.from ?? 0; },
    get selectionEnd() { return viewRef.current?.state.selection.main.to ?? 0; },
    setSelectionRange(start, end) {
      const v = viewRef.current;
      if (!v) return;
      const len = v.state.doc.length;
      v.dispatch({ selection: { anchor: Math.min(start, len), head: Math.min(end, len) }, scrollIntoView: true });
    },
    focus() { viewRef.current?.focus(); },
  });
  useImperativeHandle(ref, () => box.current, []);

  /** `Composer` 의 열쇠 처리기를 부른다. 막았으면(`preventDefault`) 참. */
  const runKeyHandler = (e: KeyboardEvent): boolean => {
    const handler = latest.current.onKeyDown;
    if (!handler) return false;
    handler({
      key: e.key, code: e.code, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey,
      altKey: e.altKey, isComposing: e.isComposing, editorComposing: viewRef.current?.composing ?? false,
      preventDefault: () => e.preventDefault(),
      currentTarget: box.current,
    });
    return e.defaultPrevented;
  };
  /** 캡처 단계에서 먼저 처리한 keydown. CodeMirror 의 처리기 단계가 같은 이벤트를 다시 부르지 않게 한다. */
  const handledEarly = useRef(new WeakSet<KeyboardEvent>()).current;

  useLayoutEffect(() => {
    const extensions: Extension[] = [
      history(),
      EditorView.lineWrapping,
      // 붙여넣은 주소를 링크로 바꾸는 것과 목록 잇기는 `Composer` 가 한다(링크 제안 버튼·Shift+Enter) —
      // 편집기의 것까지 켜면 같은 일을 두 번, 다른 규칙으로 한다.
      markdown({ extensions: [Strikethrough], pasteURLAsLink: false, addKeymap: false }),
      syntaxHighlighting(mdHighlight),
      liveMarks,
      EditorView.contentAttributes.of({ 'aria-multiline': 'true', role: 'textbox' }),
      /*
        `Composer` 의 열쇠 처리기가 **편집기 기본 열쇠보다 먼저** 본다. 기본 열쇠표(`defaultKeymap`)는
        Enter 를 줄바꿈으로 먹어 버리므로, 같은 순위면 Enter 가 보내기에 닿지 못한다.
      */
      Prec.highest(EditorView.domEventHandlers({
        // 조합 직후 Enter 는 아래 캡처 단계에서 이미 처리했다(`handledEarly`) — 두 번 보내지 않는다.
        keydown: (e) => (handledEarly.has(e) ? e.defaultPrevented : runKeyHandler(e)),
        paste: (e) => {
          const handler = latest.current.onPaste;
          if (!handler || !e.clipboardData) return false;
          handler({ clipboardData: e.clipboardData, preventDefault: () => e.preventDefault(), currentTarget: box.current });
          return e.defaultPrevented;
        },
      })),
      keymap.of([...historyKeymap, ...defaultKeymap]),
      EditorView.updateListener.of((u) => {
        if (syncing.current) return;
        const caret = u.state.selection.main.head;
        if (u.docChanged) latest.current.onChange(u.state.doc.toString(), caret);
        else if (u.selectionSet) latest.current.onSelect?.(u.state.doc.toString(), caret);
      }),
    ];
    if (props.placeholder) {
      // 자리표시 글은 그림(`cmPlaceholder`)과 속성 둘 다로 둔다 — 화면 읽기 프로그램은 그림을 읽지 않는다.
      extensions.push(cmPlaceholder(props.placeholder));
      extensions.push(EditorView.contentAttributes.of({ 'aria-placeholder': props.placeholder, placeholder: props.placeholder }));
    }
    extRef.current = extensions;
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: props.value, extensions }),
    });
    viewRef.current = view;
    /*
      Enter 가 글 칸에 **도착했는지**를 CodeMirror 보다 먼저(캡처 단계) 적는다(`lib/enterTrace`). CodeMirror 는 조합 중
      키를 처리기에 넘기지 않고 버리므로, 여기 있고 `Composer` 쪽 기록이 없으면 편집기가 삼킨 것이다. 글자는 안 적는다.
    */
    /*
      **조합이 끝난 직후의 Enter 는 CodeMirror 보다 먼저 받는다**(10-22 「글 끝에서 Enter 를 두 번 쳐야 보내진다」).

      CodeMirror 는 Safari 계열(WKWebView 포함)에서 `compositionend` 뒤 100ms 안에 오는 keydown 을 「입력기가 확정에 쓴
      키」로 보고 **처리기에 넘기지 않는다**(`@codemirror/view` `ignoreDuringComposition` · `compositionPendingKey`).
      맥 한글 입력기는 마지막 음절을 확정한 뒤 그 Enter 를 따로 보낸다 — 확정은 이미 끝났고 이 Enter 는 보내기다. 그런데
      버려지면 아무도 막지 않아 브라우저가 줄을 바꾸고, 다음 Enter 가 빈 줄을 단 채 보냈다(진단 덤프: raw 는 있고 key 가
      없음, isComposing·편집기 조합 상태 둘 다 false).

      그래서 그 창 안의 Enter 만 여기서(캡처 단계) 처리기에 넘기고, 막았으면 CodeMirror 에 내려가지 않게 멈춘다. 창은
      CodeMirror 의 100ms 보다 넉넉히 잡는다 — 우리가 먼저 처리하면 CodeMirror 단계는 `handledEarly` 로 건너뛰므로 창이
      겹쳐도 두 번 불리지 않는다. 조합이 **진행 중**(`view.composing`)이면 건드리지 않는다 — 그 Enter 는 입력기의 것이다.
    */
    let compositionEndedAt = -Infinity;
    const onCompositionEnd = () => { compositionEndedAt = Date.now(); };
    const onRawKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.keyCode !== 13) return;
      recordEnter({
        kind: 'raw', key: e.key, code: e.code, keyCode: e.keyCode, shift: e.shiftKey, meta: e.metaKey || e.ctrlKey,
        isComposing: e.isComposing, editorComposing: view.composing, docLen: view.state.doc.length, focus: focusKind(view.dom.ownerDocument),
      });
      if (view.composing || e.isComposing || Date.now() - compositionEndedAt > AFTER_COMPOSITION_MS) return;
      handledEarly.add(e);
      if (runKeyHandler(e)) e.stopImmediatePropagation();
    };
    view.contentDOM.addEventListener('compositionend', onCompositionEnd, true);
    view.contentDOM.addEventListener('keydown', onRawKey, true);
    if (props.autoFocus) view.focus();
    return () => {
      view.contentDOM.removeEventListener('compositionend', onCompositionEnd, true);
      view.contentDOM.removeEventListener('keydown', onRawKey, true);
      view.destroy();
      viewRef.current = null;
    };
    // 자리표시 글은 처음 한 번만 — 바뀌면 다시 만든다.
  }, [props.placeholder]); // eslint-disable-line react-hooks/exhaustive-deps

  /*
    자리가 바뀌면 상태를 새로 짜서 되돌리기 기록을 버린다(`historyKey` 주석). 아래의 값 맞추기보다 **먼저**
    돌아야 한다 — 그래야 새 자리의 초안이 기록 없는 새 상태의 첫 글이 되고, 값 맞추기는 할 일이 없다.
    `setState` 는 갱신 알림(`updateListener`)을 부르지 않으므로 새 초안이 onChange 로 되돌아가지 않는다.
  */
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || lastHistoryKey.current === props.historyKey) return;
    lastHistoryKey.current = props.historyKey;
    view.setState(EditorState.create({
      doc: props.value,
      extensions: extRef.current,
      selection: { anchor: props.value.length },
    }));
  }, [props.historyKey, props.value]);

  /*
    바깥(보내기·되돌리기·⌘E·멘션 고르기)에서 바뀐 값을 편집기에 옮긴다. **레이아웃 효과**인 것이 요점이다:
    `Composer` 는 멘션을 고른 뒤 같은 렌더의 레이아웃 효과에서 커서를 새 글의 끝에 둔다. 자식의 레이아웃
    효과가 부모의 것보다 먼저 돌므로 여기서 글을 먼저 바꿔 두어야 그 커서가 옛 글 길이에 잘리지 않는다
    (잘리면 커서가 `@fi` 안에 남아 자동완성이 다시 열린다).
  */
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur === props.value) return;
    syncing.current = true;
    try {
      const len = props.value.length;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: props.value },
        selection: { anchor: Math.min(sel.anchor, len), head: Math.min(sel.head, len) },
        /*
          바깥에서 넣은 값은 되돌리기 기록에 올리지 않는다. 올리면 보낸 뒤 ⌘Z 가 보낸 글을 되살려 다시
          보내기 쉽고, 기록이 사람이 친 것과 코드가 넣은 것을 섞는다(textarea 도 코드로 넣은 값은 기록을 끊었다).
        */
        annotations: Transaction.addToHistory.of(false),
      });
    } finally {
      syncing.current = false;
    }
  }, [props.value]);

  /*
    높이 상한 = 이 입력창이 든 칸(채널 `main`·스레드 `section`) 높이의 40%(결정 8). 창 높이(`vh`)가
    아니라 칸 높이인 것은 스레드 패널·분할 창에서도 대화가 입력창에 묻히지 않게 하려는 것이다.
    칸을 못 찾거나 배치가 없으면(시험) CSS 의 `40vh` 가 남는다.
  */
  useEffect(() => {
    const el = host.current;
    const pane = el?.closest('main, section');
    if (!el || !pane) return;
    const apply = () => {
      const h = pane.clientHeight;
      if (h > 0) el.style.setProperty('--composer-max', `${Math.round(h * 0.4)}px`);
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(pane);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = viewRef.current?.contentDOM;
    if (!el) return;
    const set = (k: string, v: string | undefined) => (v === undefined ? el.removeAttribute(k) : el.setAttribute(k, v));
    set('aria-expanded', props.ariaExpanded === undefined ? undefined : String(props.ariaExpanded));
    set('aria-controls', props.ariaControls);
    set('aria-activedescendant', props.ariaActiveDescendant);
  }, [props.ariaExpanded, props.ariaControls, props.ariaActiveDescendant]);

  const rows = props.rows ?? 2;
  return (
    <div
      ref={host}
      data-testid="composer-editor"
      className={`composer-cm ${props.className ?? ''}`}
      style={{ ['--composer-rows' as string]: rows }}
    />
  );
});
