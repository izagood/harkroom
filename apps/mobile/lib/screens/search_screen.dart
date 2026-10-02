import 'dart:async';

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../i18n/i18n.dart';
import '../mention/render.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../ui/states.dart';
import '../ui/tokens.dart';
import 'message_link.dart';
import 'message_list_screen.dart';
import 'message_tile.dart';

/// 찾기의 범위. **연 자리가 정한다**(designer 찾기 안 F1): 탭 막대 버튼 = 전체, 채널 머리 = 이
/// 채널, 스레드 머리 = 이 스레드. 데스크톱 `SearchPalette` 의 ⌘K·⌘F 와 같은 물음이다.
enum SearchScope { all, channel, thread }

/// 찾기 화면을 연다. [channelId]·[threadRootId] 는 그 범위를 고를 수 있게 하는 맥락이다 —
/// 탭 막대에서 열면 둘 다 없고, 범위 칩은 「전체」 하나뿐이다.
Future<void> openSearch(
  BuildContext context, {
  SearchScope scope = SearchScope.all,
  String? channelId,
  String? threadRootId,
}) =>
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => SearchScreen(initialScope: scope, channelId: channelId, threadRootId: threadRootId),
    ));

/// 탭 막대·머리에 다는 돋보기. 열쇠는 시험과 VoiceOver 가 찾는 자리다.
class SearchButton extends StatelessWidget {
  const SearchButton({super.key, this.scope = SearchScope.all, this.channelId, this.threadRootId});

  final SearchScope scope;
  final String? channelId;
  final String? threadRootId;

  @override
  Widget build(BuildContext context) => IconButton(
        tooltip: context.t.searchButton,
        icon: const Icon(Icons.search),
        onPressed: () => openSearch(context, scope: scope, channelId: channelId, threadRootId: threadRootId),
      );
}

/// 메시지 찾기 화면.
///
/// - 입력은 **300ms 디바운스**, **두 글자부터** 보낸다(데스크톱과 같다). 한 글자는 결과가 너무
///   많고 느리다 — 서버는 막지 않지만 쓸모가 없다.
/// - 찾는 중에도 **앞 결과를 지우지 않는다** — 칠 때마다 목록이 비었다 차면 깜빡여 읽을 수 없다.
///   입력 오른쪽의 작은 스피너만 돈다.
/// - 늦게 온 옛 답은 버린다(요청 번호). 「배」 의 답이 「배포」 의 답 뒤에 오면 틀린 목록이 선다.
/// - 결과를 누르면 그 스레드로 간다([openMessageRow]). 이 화면은 스택에 남으므로 뒤로 오면
///   결과와 스크롤이 그대로다.
class SearchScreen extends StatefulWidget {
  const SearchScreen({super.key, this.initialScope = SearchScope.all, this.channelId, this.threadRootId});

  final SearchScope initialScope;
  final String? channelId;
  final String? threadRootId;

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

/// 서버에 보내는 최소 길이.
const int searchMinChars = 2;

/// 입력이 멎은 뒤 보내기까지.
const Duration searchDebounce = Duration(milliseconds: 300);

class _SearchScreenState extends State<SearchScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  Timer? _debounce;
  late SearchScope _scope = _clamp(widget.initialScope);

  /// 지금 화면에 선 결과가 **무엇을 찾은 것인지**. 입력칸 글자와 다를 수 있다(디바운스 중).
  String _shown = '';
  List<MessageRow> _results = const [];
  bool _hasMore = false;
  bool _loading = false;
  bool _loadingMore = false;
  LoadFailure? _failure;

  /// 마지막으로 보낸 요청의 번호. 답이 왔을 때 이 값이 아니면 늦은 답이다.
  int _req = 0;

  /// 맥락이 없는 범위는 고를 수 없다 — 스레드 범위인데 스레드 id 가 없으면 채널로, 그것도 없으면 전체로.
  SearchScope _clamp(SearchScope s) => switch (s) {
        SearchScope.thread when widget.threadRootId != null && widget.channelId != null => SearchScope.thread,
        SearchScope.thread || SearchScope.channel when widget.channelId != null => SearchScope.channel,
        _ => SearchScope.all,
      };

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    // 빌드 밖이라 구독하지 않고 읽는다.
    AppScope.read(context).loadRecentSearches();
  }

  /// 최근 찾은 말을 누르면 그 말로 바로 찾는다.
  void _useRecent(String q) {
    _input.text = q;
    _input.selection = TextSelection.collapsed(offset: q.length);
    _debounce?.cancel();
    _run(q);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _onChanged(String _) {
    _debounce?.cancel();
    final q = _input.text.trim();
    if (q.length < searchMinChars) {
      // 덜 친 것은 보내지 않고, 앞 결과도 내린다 — 「배포」 를 지워 「배」 가 됐는데 「배포」
      // 결과가 남아 있으면 지금 입력의 결과로 읽힌다.
      _req++;
      setState(() {
        _shown = '';
        _results = const [];
        _hasMore = false;
        _loading = false;
        _failure = null;
      });
      return;
    }
    _debounce = Timer(searchDebounce, () => _run(q));
  }

  ({String? channelId, String? threadRootId}) get _target => switch (_scope) {
        SearchScope.all => (channelId: null, threadRootId: null),
        SearchScope.channel => (channelId: widget.channelId, threadRootId: null),
        SearchScope.thread => (channelId: widget.channelId, threadRootId: widget.threadRootId),
      };

  Future<void> _run(String q) async {
    final req = ++_req;
    setState(() {
      _loading = true;
      _failure = null;
    });
    final target = _target;
    try {
      final page = await context.app.searchMessages(q, channelId: target.channelId, threadRootId: target.threadRootId);
      if (!mounted || req != _req || page == null) return;
      setState(() {
        _shown = q;
        _results = page.messages;
        _hasMore = page.hasMore;
        _loading = false;
      });
      if (_scroll.hasClients) _scroll.jumpTo(0);
    } on Object catch (e) {
      if (!mounted || req != _req) return;
      setState(() {
        _shown = q;
        _results = const [];
        _hasMore = false;
        _loading = false;
        _failure = LoadFailure.of(e);
      });
    }
  }

  void _onScroll() {
    if (!_hasMore || _loading || _loadingMore) return;
    if (_scroll.position.extentAfter < 400) _more();
  }

  Future<void> _more() async {
    final req = _req;
    final q = _shown;
    final target = _target;
    setState(() => _loadingMore = true);
    try {
      final page = await context.app.searchMessages(q,
          channelId: target.channelId, threadRootId: target.threadRootId, offset: _results.length);
      if (!mounted || req != _req || page == null) return;
      // 그 사이 새 글이 들어오면 offset 이 한 칸 밀려 같은 행이 두 번 올 수 있다 — id 로 거른다.
      final seen = {for (final m in _results) m.id};
      setState(() {
        _results = [..._results, ...page.messages.where((m) => !seen.contains(m.id))];
        _hasMore = page.hasMore;
      });
    } on Object {
      if (!mounted || req != _req) return;
      // 앞 결과는 그대로 두고 토스트만 — 이미 읽던 목록을 실패 화면으로 덮지 않는다.
      setState(() => _hasMore = false);
      showFailureToast(context, context.t.searchMoreFailed, retry: () {
        if (mounted && req == _req) {
          setState(() => _hasMore = true);
          _more();
        }
      });
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  void _setScope(SearchScope s) {
    if (s == _scope) return;
    setState(() => _scope = s);
    final q = _input.text.trim();
    if (q.length >= searchMinChars) {
      _debounce?.cancel();
      _run(q);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final app = context.app;
    ChannelRow? channel;
    for (final c in app.channels) {
      if (c.id == widget.channelId) channel = c;
    }

    return Scaffold(
      appBar: AppBar(
        automaticallyImplyLeading: false,
        titleSpacing: HarkroomSize.gutter,
        title: TextField(
          key: const Key('search-input'),
          controller: _input,
          autofocus: true,
          textInputAction: TextInputAction.search,
          onChanged: _onChanged,
          onSubmitted: (_) {
            _debounce?.cancel();
            final q = _input.text.trim();
            if (q.length >= searchMinChars) {
              _run(q);
              app.rememberSearch(q);
            }
          },
          decoration: InputDecoration(
            hintText: t.searchHint,
            prefixIcon: const Icon(Icons.search, size: 20),
            suffixIcon: _loading
                ? const Padding(
                    padding: EdgeInsets.all(12),
                    child: SizedBox(
                      key: Key('search-spinner'),
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                : null,
            isDense: true,
            filled: true,
            fillColor: k.soft,
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(20), borderSide: BorderSide.none),
          ),
        ),
        actions: [
          TextButton(
            key: const Key('search-cancel'),
            onPressed: () => Navigator.of(context).maybePop(),
            child: Text(t.searchCancel),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (widget.channelId != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 8, HarkroomSize.gutter, 4),
                child: Wrap(
                  spacing: 8,
                  children: [
                    _ScopeChip(
                      key: const Key('search-scope-all'),
                      label: t.searchScopeAll,
                      selected: _scope == SearchScope.all,
                      onTap: () => _setScope(SearchScope.all),
                    ),
                    _ScopeChip(
                      key: const Key('search-scope-channel'),
                      label: channelLabel(channel),
                      selected: _scope == SearchScope.channel,
                      onTap: () => _setScope(SearchScope.channel),
                    ),
                    if (widget.threadRootId != null)
                      _ScopeChip(
                        key: const Key('search-scope-thread'),
                        label: t.searchScopeThread,
                        selected: _scope == SearchScope.thread,
                        onTap: () => _setScope(SearchScope.thread),
                      ),
                  ],
                ),
              ),
            Expanded(child: _body(context)),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context) {
    final t = context.t;
    if (_failure != null) {
      return FailedState(title: t.searchFailed, cause: _failure!, onRetry: () => _run(_shown));
    }
    final shortcuts = _input.text.trim().isEmpty ? const <ChannelRow>[] : searchShortcuts(context.app, _input.text);
    if (_shown.isEmpty) {
      if (_loading) return const SizedBox.shrink();
      final recent = context.app.recentSearches;
      if (shortcuts.isEmpty && recent.isEmpty) return EmptyState(title: t.searchStart);
      // 아직 아무것도 안 찾았다 — 이름이 맞는 대화(바로 가기)와 최근 찾은 말.
      return ListView(
        key: const Key('search-idle'),
        keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
        children: [
          ..._shortcutRows(context, shortcuts),
          if (recent.isNotEmpty) ...[
            _SectionHeader(
              label: t.searchRecent,
              trailing: TextButton(
                key: const Key('search-recent-clear'),
                onPressed: () => context.app.forgetSearch(null),
                child: Text(t.searchRecentClear),
              ),
            ),
            for (final q in recent)
              ListTile(
                key: Key('search-recent-$q'),
                dense: true,
                leading: Icon(Icons.history, size: 20, color: context.tokens.mute),
                title: Text(q),
                trailing: IconButton(
                  tooltip: t.searchRecentRemove,
                  icon: const Icon(Icons.close, size: 18),
                  onPressed: () => context.app.forgetSearch(q),
                ),
                onTap: () => _useRecent(q),
              ),
          ],
        ],
      );
    }
    if (_results.isEmpty) {
      final none = _noResults(context);
      // 메시지는 없어도 이름이 맞는 대화는 있을 수 있다 — 그때는 바로 가기를 위에 두고 그 아래에 0건 말.
      if (shortcuts.isEmpty) return none;
      return ListView(children: [..._shortcutRows(context, shortcuts), none]);
    }
    return _resultList(context, shortcuts);
  }

  Widget _noResults(BuildContext context) {
    final t = context.t;
    return Center(
      key: const Key('search-empty'),
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(t.searchNoResults.replaceFirst('{q}', _shown),
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: context.tokens.fg)),
            // 두 글자는 서버가 낱말 앞부분으로만 맞춘다(중간일치는 세 글자부터). 숨기지 않고 말한다.
            if (_shown.length == searchMinChars) ...[
              const SizedBox(height: 6),
              Text(t.searchTwoLetterHint,
                  textAlign: TextAlign.center, style: TextStyle(fontSize: 13, color: context.tokens.mute)),
            ],
            if (_scope != SearchScope.all) ...[
              const SizedBox(height: 12),
              OutlinedButton(
                key: const Key('search-everywhere'),
                onPressed: () => _setScope(SearchScope.all),
                child: Text(t.searchEverywhere),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _resultList(BuildContext context, List<ChannelRow> shortcuts) {
    return ListView.separated(
      key: const Key('search-results'),
      controller: _scroll,
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: const EdgeInsets.only(bottom: 24),
      itemCount: _results.length + (_loadingMore ? 1 : 0) + (shortcuts.isEmpty ? 0 : 1),
      separatorBuilder: (_, _) => Divider(height: 1, color: context.tokens.line),
      itemBuilder: (context, i) {
        // 이름이 맞는 대화가 있으면 결과 위에 한 묶음으로.
        if (shortcuts.isNotEmpty) {
          if (i == 0) return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: _shortcutRows(context, shortcuts));
          i -= 1;
        }
        if (i == _results.length) {
          return const Padding(
            padding: EdgeInsets.all(16),
            child: Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))),
          );
        }
        return SearchResultTile(
          message: _results[i],
          query: _shown,
          onOpened: () => context.app.rememberSearch(_shown),
        );
      },
    );
  }

  List<Widget> _shortcutRows(BuildContext context, List<ChannelRow> shortcuts) {
    if (shortcuts.isEmpty) return const [];
    return [
      _SectionHeader(label: context.t.searchShortcuts),
      for (final c in shortcuts)
        ListTile(
          key: Key('search-shortcut-${c.id}'),
          dense: true,
          leading: Icon(c.isDm ? Icons.person_outline : Icons.tag, size: 20, color: context.tokens.mute),
          title: Text(c.name),
          subtitle: c.isDm ? Text(context.t.tabDms) : null,
          onTap: () {
            context.app.openChannel(c.id);
            Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => MessageListScreen(channelId: c.id)));
          },
        ),
    ];
  }
}

/// 바로 가기: 이름이 친 말을 담은 채널·DM(이미 받은 목록에서 — 서버를 묻지 않는다). 앞부분이 맞는 것을
/// 먼저, 그 안에서 원래 순서. 많으면 산만하니 5개까지.
List<ChannelRow> searchShortcuts(AppState app, String query) {
  final q = query.trim().toLowerCase().replaceFirst(RegExp(r'^[#@]'), '');
  if (q.isEmpty) return const [];
  final starts = <ChannelRow>[];
  final contains = <ChannelRow>[];
  for (final c in app.channels) {
    final name = c.name.toLowerCase();
    if (name.startsWith(q)) {
      starts.add(c);
    } else if (name.contains(q)) {
      contains.add(c);
    }
  }
  return [...starts, ...contains].take(5).toList(growable: false);
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.label, this.trailing});

  final String label;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 10, 8, 2),
        child: Row(children: [
          Expanded(
            child: Text(label,
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: context.tokens.mute)),
          ),
          ?trailing,
        ]),
      );
}

class _ScopeChip extends StatelessWidget {
  const _ScopeChip({super.key, required this.label, required this.selected, required this.onTap});

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    // 고른 칩은 먹색 바탕 + 흰 글자 — 지금 어디서 찾는지가 이 화면의 첫 정보다(designer #1092 f2).
    // 「흰」 은 다크에서도 바탕(`fg` = 밝은 글자색)과 맞서는 색이어야 하므로 `bg` 를 쓴다.
    return ChoiceChip(
      label: Text(label),
      selected: selected,
      showCheckmark: false,
      selectedColor: k.fg,
      backgroundColor: k.bg,
      side: BorderSide(color: selected ? k.fg : k.line),
      labelStyle: TextStyle(color: selected ? k.bg : k.mute, fontWeight: selected ? FontWeight.w600 : FontWeight.w400),
      onSelected: (_) => onTap(),
    );
  }
}

/// 결과 한 줄: **어디(채널·스레드) · 누가 · 언제** + 본문 두 줄, 찾은 낱말 강조.
class SearchResultTile extends StatelessWidget {
  const SearchResultTile({super.key, required this.message, required this.query, this.onOpened});

  final MessageRow message;
  final String query;

  /// 눌러 열었을 때(최근 찾은 말에 넣는 자리).
  final VoidCallback? onOpened;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final app = context.app;
    ChannelRow? channel;
    for (final c in app.channels) {
      if (c.id == message.channelId) channel = c;
    }
    // DM 은 「DM · 이름」 — 이름만 두면 그 이름의 채널로 읽힌다(designer #1092 f3).
    final where = [
      if (channel?.isDm ?? false) t.tabDms,
      channelLabel(channel),
      if (message.threadRootId != null) t.searchInThread,
    ].where((s) => s.isNotEmpty).join(' · ');
    final who = app.displayNameOf(message.authorId);
    final when = dayLabel(t, message.createdAt);
    // 본문은 한 덩어리로 — 줄바꿈이 두 줄 칸을 첫 줄에서 다 먹지 않게.
    final full = renderMentions(message.body, app.accounts, t.mentionUnknown).replaceAll(RegExp(r'\s+'), ' ').trim();
    // 찾은 낱말이 두 줄 밖에 있으면 강조가 안 보여 왜 걸렸는지 모른다 — 첫 일치 앞에서 자른 발췌로 보인다.
    final body = searchExcerpt(full, query);

    return Semantics(
      button: true,
      excludeSemantics: true,
      // VoiceOver 는 한 문장으로 읽는다: "# task, jaebin, 어제, 서버 최신버전 배포해".
      label: [where, who, when, body].where((s) => s.isNotEmpty).join(', '),
      child: InkWell(
        key: Key('search-result-${message.id}'),
        onTap: () {
          onOpened?.call();
          openMessageRow(context, message);
        },
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: HarkroomSize.gutter, vertical: 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text.rich(
                TextSpan(children: [
                  if (where.isNotEmpty) TextSpan(text: '$where · '),
                  TextSpan(text: who, style: TextStyle(fontWeight: FontWeight.w600, color: k.fg)),
                  TextSpan(text: ' · $when'),
                ]),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12, color: k.mute),
              ),
              const SizedBox(height: 2),
              Text.rich(
                TextSpan(children: highlightSpans(body, query, TextStyle(backgroundColor: k.warnSoft, color: k.fg, fontWeight: FontWeight.w600))),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 14, color: k.fg),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 결과 줄 본문 두 칸에 대략 들어가는 글자 수(한글 기준). 일치가 이 안에 끝나면 자르지 않는다.
const int searchExcerptVisible = 40;

/// 찾은 낱말이 보이게 자른 발췌(designer #1092 f1, Slack 과 같다).
///
/// - 첫 일치가 **보이는 칸([visible]) 안에서 끝나면 자르지 않는다** — 두 줄에 들어가는 글을 자르면
///   잃기만 한다. 이 앱의 글은 거의 `@에이전트 …` 로 시작해 가장 흔한 줄이 그 꼴이다(#1094 D1).
/// - 자르면 일치 앞 [lead] 글자쯤에서 「…」 로 시작한다. 그 자리가 낱말 가운데면 일치 앞의 첫 공백
///   뒤로 물리고, 그런 공백이 없으면 앞쪽 가까운 공백으로, 그것도 없으면 **자르지 않는다**.
String searchExcerpt(String text, String query, {int visible = searchExcerptVisible, int lead = 20}) {
  final words = _queryWords(query);
  final lower = text.toLowerCase();
  if (lower.length != text.length) return text;
  var first = -1;
  var end = -1;
  for (final w in words) {
    final at = lower.indexOf(w);
    if (at >= 0 && (first < 0 || at < first)) {
      first = at;
      end = at + w.length;
    }
  }
  if (first < 0 || end <= visible || first <= lead) return text;
  var start = first - lead;
  if (text[start - 1] != ' ') {
    final ahead = text.indexOf(' ', start);
    final behind = text.lastIndexOf(' ', start - 1);
    if (ahead >= 0 && ahead < first) {
      start = ahead + 1;
    } else if (behind >= 0 && first - behind <= lead + 10) {
      start = behind + 1;
    } else {
      return text;
    }
  }
  return '…${text.substring(start)}';
}

List<String> _queryWords(String query) => query
    .split(RegExp(r'\s+'))
    .map((w) => w.replaceAll(RegExp(r'^[-"]+|"+$'), '').toLowerCase())
    .where((w) => w.isNotEmpty)
    .toSet()
    .toList()
  // 긴 낱말을 먼저 — 「배포」 와 「배포해」 가 같이 있으면 긴 쪽이 이긴다.
  ..sort((a, b) => b.length.compareTo(a.length));

/// [text] 안에서 [query] 의 낱말(공백으로 나눈 것)이 나온 자리를 [mark] 로 칠한다. 대소문자는 가리지 않는다.
///
/// 서버는 낱말 **앞부분**(접두)과 세 글자 이상 **중간일치**로 맞춘다 — 둘 다 결국 그 글자가 본문
/// 어딘가에 있다는 뜻이라, 글자 그대로 찾아 칠하면 서버가 맞춘 자리와 같다. 따옴표·`-` 같은 검색
/// 문법 기호는 낱말에서 떼고 칠한다(`"배포 순서"` 의 따옴표는 본문에 없다).
List<InlineSpan> highlightSpans(String text, String query, TextStyle mark) {
  final words = _queryWords(query);
  if (words.isEmpty) return [TextSpan(text: text)];
  final lower = text.toLowerCase();
  // 길이가 바뀌는 소문자화(드문 유니코드)면 자리가 어긋난다 — 그때는 칠하지 않는다.
  if (lower.length != text.length) return [TextSpan(text: text)];
  final marks = List<bool>.filled(text.length, false);
  for (final w in words) {
    var from = 0;
    while (true) {
      final at = lower.indexOf(w, from);
      if (at < 0) break;
      for (var i = at; i < at + w.length; i++) {
        marks[i] = true;
      }
      from = at + w.length;
    }
  }
  final spans = <InlineSpan>[];
  var start = 0;
  for (var i = 1; i <= text.length; i++) {
    if (i == text.length || marks[i] != marks[start]) {
      final piece = text.substring(start, i);
      spans.add(marks[start] ? TextSpan(text: piece, style: mark) : TextSpan(text: piece));
      start = i;
    }
  }
  return spans;
}
