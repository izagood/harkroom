import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';

import '../api/api_error.dart';
import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../ui/parts.dart';
import '../ui/states.dart';
import '../ui/tokens.dart';
import 'message_list_screen.dart';

/// 채널 만들기·정보·편집(designer 흐름 c1~c4). 데스크톱의 사이드바 「＋ 채널」·채널 설정 시트(정보·멤버 탭)를
/// 폰에 옮긴 것이다 — 데스크톱이 하는 것만 한다(공개 범위 바꾸기·채널 삭제·팀 추가는 없다).
///
/// 손잡이는 데스크톱과 같은 규칙으로 그린다. 판정은 서버가 하고, 여기서는 눌러서 403 이 날 버튼을 세우지 않을 뿐이다.
/// - 만들기: `channel.create` 능력
/// - 편집·보관: `channel.manage` 능력
/// - 멤버 추가: 명단을 받았고, 공개 채널이거나 내가 멤버일 때(`ChannelMembersPanel` 의 `canInvite`)
/// - 내보내기: admin 이고 내가 아닌 줄
/// - 보관된 채널은 추가·내보내기를 숨긴다(서버가 400 `channel_archived` 로 막는다). 나가기는 된다.

/// 서버 `CHANNEL_NAME_PATTERN`(shared) 과 같은 규칙. 미리 걸러 [만들기]·[저장]을 끄지만 최종 판정은 서버다.
final channelNamePattern = RegExp(r'^[a-z0-9_-]{1,48}$');

/// 이름 칸을 입력하는 동안 규칙에 맞춘다(시안 v1 결정 3): 영문 대문자 → 소문자, 띄어쓰기 → `-`.
/// 한 글자를 한 글자로만 바꾼다 — 길이가 그대로라 커서·조합 범위(한글 IME)가 어긋나지 않는다.
/// 바꿀 수 없는 글자(한글 등)는 지우지 않는다 — [channelNameProblem] 이 칸 아래 빨간 줄로 알린다.
class ChannelNameFormatter extends TextInputFormatter {
  const ChannelNameFormatter();

  static String normalize(String s) => s.replaceAllMapped(RegExp(r'[A-Z\s]'), (m) {
        final c = m[0]!;
        return RegExp(r'\s').hasMatch(c) ? '-' : c.toLowerCase();
      });

  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) {
    final text = normalize(newValue.text);
    return text == newValue.text ? newValue : newValue.copyWith(text: text);
  }
}

/// 이름 칸 아래 빨간 줄(시안 v1 ②). 빈 칸은 아직 고칠 것이 없다 — [만들기]만 꺼 둔다.
String? channelNameProblem(Strings t, String name) {
  if (name.isEmpty) return null;
  if (!RegExp(r'^[a-z0-9_-]*$').hasMatch(name)) return t.chNameBadChars;
  if (name.length > 48) return t.chNameTooLong;
  return null;
}

Future<void> openNewChannel(BuildContext context) =>
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const NewChannelScreen()));

Future<void> openChannelInfo(BuildContext context, String channelId) =>
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ChannelInfoScreen(channelId: channelId)));

/// 홈 머리의 ＋(새 채널). `channel.create` 능력이 없으면 아무것도 그리지 않는다.
class NewChannelButton extends StatelessWidget {
  const NewChannelButton({super.key});

  @override
  Widget build(BuildContext context) {
    if (context.app.me?.can('channel.create') != true) return const SizedBox.shrink();
    return IconButton(
      key: const Key('new-channel'),
      tooltip: context.t.chNew,
      icon: const Icon(Icons.add),
      onPressed: () => openNewChannel(context),
    );
  }
}

SnackBar _snack(String text) => SnackBar(content: Text(text), behavior: SnackBarBehavior.floating);

String _who(AccountView? a, String fallback) =>
    a == null ? fallback : (a.displayName.isNotEmpty ? a.displayName : a.handle);

/// 「새 채널」 — 탭 쌓기에 민다(NewDm 과 같다). 만들면 그 채널로 **바꿔 끼운다** — 뒤로 가면 홈이다.
class NewChannelScreen extends StatefulWidget {
  const NewChannelScreen({super.key});

  @override
  State<NewChannelScreen> createState() => _NewChannelScreenState();
}

class _NewChannelScreenState extends State<NewChannelScreen> {
  final _name = TextEditingController();
  final _topic = TextEditingController();
  bool _private = false;
  final List<String> _members = [];
  bool _busy = false;

  /// 이름 칸 아래 빨간 줄 — 서버가 이름을 거절했을 때만(designer: 스낵바 아님).
  String? _nameError;

  @override
  void dispose() {
    _name.dispose();
    _topic.dispose();
    super.dispose();
  }

  bool get _nameOk => channelNamePattern.hasMatch(_name.text.trim());

  Future<void> _pickMembers() async {
    final picked = await Navigator.of(context).push<List<String>>(
      MaterialPageRoute(builder: (_) => MemberPickerScreen(initial: _members)),
    );
    if (picked == null || !mounted) return;
    setState(() => _members
      ..clear()
      ..addAll(picked));
  }

  Future<void> _create() async {
    if (_busy || !_nameOk) return;
    setState(() {
      _busy = true;
      _nameError = null;
    });
    final t = context.t;
    final app = context.app;
    final nav = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final r = await app.createChannel(
        name: _name.text.trim(),
        topic: _topic.text.trim(),
        isPrivate: _private,
        memberIds: List.of(_members),
      );
      if (!mounted || r == null) return;
      await app.openChannel(r.channel.id);
      if (!mounted) return;
      final failed = r.failedMemberIds.length;
      await nav.pushReplacement(MaterialPageRoute<void>(builder: (_) => MessageListScreen(channelId: r.channel.id)));
      if (failed > 0) messenger.showSnackBar(_snack(t.chMembersPartial('$failed')));
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        // 이름 탓인 거절만 칸 아래로 — 고칠 수 있는 실패다. 그 밖은 스낵바.
        if (e.code == 'channel_name_taken' || e.status == 409) _nameError = t.chNameTaken;
      });
      if (_nameError == null) messenger.showSnackBar(_snack(t.chCreateFailed));
    } catch (_) {
      if (!mounted) return;
      setState(() => _busy = false);
      messenger.showSnackBar(_snack(t.chCreateFailed));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final k = context.tokens;
    return Scaffold(
      appBar: AppBar(
        title: Text(t.chNew),
        actions: [
          TextButton(
            key: const Key('new-channel-create'),
            onPressed: _busy || !_nameOk ? null : _create,
            child: Text(t.chCreate),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: SafeArea(
        child: AbsorbPointer(
          absorbing: _busy,
          child: ListView(
            key: const Key('new-channel-form'),
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 12, HarkroomSize.gutter, 24),
            children: [
              if (_busy) const LinearProgressIndicator(minHeight: 2),
              TextField(
                key: const Key('new-channel-name'),
                controller: _name,
                autofocus: true,
                autocorrect: false,
                enableSuggestions: false,
                textInputAction: TextInputAction.next,
                inputFormatters: const [ChannelNameFormatter()],
                onChanged: (_) => setState(() => _nameError = null),
                decoration: InputDecoration(
                  labelText: t.chNameLabel,
                  prefixText: _private ? '🔒 ' : '# ',
                  helperText: t.chNameRule,
                  helperMaxLines: 2,
                  errorText: _nameError ?? channelNameProblem(t, _name.text.trim()),
                  errorMaxLines: 2,
                ),
              ),
              const SizedBox(height: 20),
              Text(t.chVisibility, style: TextStyle(fontSize: HarkroomType.meta, color: k.fgMuted)),
              const SizedBox(height: 6),
              SegmentedButton<bool>(
                key: const Key('new-channel-visibility'),
                showSelectedIcon: false,
                segments: [
                  ButtonSegment(value: false, label: Text(t.chPublic, key: const Key('new-channel-public'))),
                  ButtonSegment(value: true, label: Text(t.chPrivate, key: const Key('new-channel-private'))),
                ],
                selected: {_private},
                onSelectionChanged: (s) => setState(() => _private = s.first),
              ),
              if (_private) ...[
                const SizedBox(height: 6),
                Text(t.chPrivateHint, style: TextStyle(fontSize: HarkroomType.meta, color: k.fgMuted)),
              ],
              const SizedBox(height: 20),
              TextField(
                key: const Key('new-channel-topic'),
                controller: _topic,
                maxLength: 256,
                minLines: 1,
                maxLines: 3,
                decoration: InputDecoration(labelText: t.chTopicOptional, counterText: ''),
              ),
              const SizedBox(height: 20),
              Text(t.chInitialMembers, style: TextStyle(fontSize: HarkroomType.meta, color: k.fgMuted)),
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  ActionChip(
                    key: const Key('new-channel-add-member'),
                    avatar: const Icon(Icons.add, size: 18),
                    label: Text(t.chAddMember),
                    onPressed: _pickMembers,
                  ),
                  for (final id in _members)
                    InputChip(
                      key: Key('new-channel-member-$id'),
                      label: Text('@${app.accounts[id]?.handle ?? id}'),
                      deleteButtonTooltipMessage: t.chRemoveChip('@${app.accounts[id]?.handle ?? id}'),
                      onDeleted: () => setState(() => _members.remove(id)),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 멤버 고르기 — 찾기 칸 하나 · 「사람」「에이전트」 두 구획 · 여러 개 체크 · [완료(n)](designer d3).
/// [exclude] 는 이미 멤버인 계정(채널 정보에서 열 때) — 목록에서 뺀다.
class MemberPickerScreen extends StatefulWidget {
  const MemberPickerScreen({super.key, this.initial = const [], this.exclude = const {}});

  final List<String> initial;
  final Set<String> exclude;

  @override
  State<MemberPickerScreen> createState() => _MemberPickerScreenState();
}

class _MemberPickerScreenState extends State<MemberPickerScreen> {
  final _filter = TextEditingController();
  late final List<String> _picked = List.of(widget.initial);

  @override
  void dispose() {
    _filter.dispose();
    super.dispose();
  }

  void _toggle(String id) => setState(() => _picked.contains(id) ? _picked.remove(id) : _picked.add(id));

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final k = context.tokens;
    final q = _filter.text.trim().toLowerCase();
    // NewDm 과 같은 거름: 나·비활성 빼기.
    final all = app.accounts.values
        .where((a) => a.id != app.me?.id && !a.isDisabled && !widget.exclude.contains(a.id))
        .where((a) => q.isEmpty || a.handle.toLowerCase().contains(q) || a.displayName.toLowerCase().contains(q))
        .toList(growable: false)
      ..sort((a, b) => a.handle.toLowerCase().compareTo(b.handle.toLowerCase()));
    final people = all.where((a) => !a.isAgent).toList(growable: false);
    final agents = all.where((a) => a.isAgent).toList(growable: false);

    Widget head(String label) => Padding(
          padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 16, HarkroomSize.gutter, 4),
          child: Text(label, style: TextStyle(fontSize: HarkroomType.meta, fontWeight: FontWeight.w600, color: k.fgMuted)),
        );
    Widget row(AccountView a) => CheckboxListTile(
          key: Key('member-pick-${a.id}'),
          value: _picked.contains(a.id),
          onChanged: (_) => _toggle(a.id),
          controlAffinity: ListTileControlAffinity.trailing,
          secondary: HarkroomAvatar(id: a.id, name: a.handle, size: HarkroomSize.avatarSmall),
          title: Text(a.displayName.isNotEmpty ? a.displayName : a.handle, maxLines: 1, overflow: TextOverflow.ellipsis),
          subtitle: a.displayName.isNotEmpty && a.displayName != a.handle ? Text('@${a.handle}') : null,
        );

    return Scaffold(
      appBar: AppBar(
        title: Text(t.chAddMember),
        actions: [
          TextButton(
            key: const Key('member-pick-done'),
            onPressed: () => Navigator.of(context).pop(_picked),
            child: Text(t.chPickDone('${_picked.length}')),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 8, HarkroomSize.gutter, 4),
              child: TextField(
                key: const Key('member-pick-filter'),
                controller: _filter,
                onChanged: (_) => setState(() {}),
                decoration: InputDecoration(prefixIcon: const Icon(Icons.search), hintText: t.chPickFilter, isDense: true),
              ),
            ),
            Expanded(
              child: all.isEmpty
                  ? EmptyState(title: t.chPickNoMatch)
                  : ListView(
                      key: const Key('member-pick-list'),
                      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
                      children: [
                        if (people.isNotEmpty) head(t.chPickPeople),
                        for (final a in people) row(a),
                        if (agents.isNotEmpty) head(t.chPickAgents),
                        for (final a in agents) row(a),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 채널 머리 제목 + ⌄ — 누르면 채널 정보(designer c2). DM 은 이것을 쓰지 않는다.
class ChannelTitleButton extends StatelessWidget {
  const ChannelTitleButton({super.key, required this.channel});

  final ChannelRow channel;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    return Semantics(
      button: true,
      label: context.t.chInfo,
      child: InkWell(
        key: const Key('channel-title'),
        borderRadius: BorderRadius.circular(6),
        onTap: () => openChannelInfo(context, channel.id),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(child: ScreenTitle(title: channelLabel(channel), subtitle: channel.topic)),
            Icon(Icons.expand_more, size: 20, color: k.fgMuted),
          ],
        ),
      ),
    );
  }
}

/// 채널 정보 — 탭 쌓기에 push(designer d1). 정보 + 멤버 + 보관·나가기.
class ChannelInfoScreen extends StatefulWidget {
  const ChannelInfoScreen({super.key, required this.channelId});

  final String channelId;

  @override
  State<ChannelInfoScreen> createState() => _ChannelInfoScreenState();
}

class _ChannelInfoScreenState extends State<ChannelInfoScreen> {
  bool _busy = false;
  bool _loadFailed = false;

  /// 내가 보관을 누른 사이에는 「보관됐다 → 닫기」를 하지 않는다 — 남이 보관한 때만 닫는다.
  bool _selfArchiving = false;
  bool _closing = false;
  bool? _wasArchived;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    if (!mounted) return;
    setState(() => _loadFailed = false);
    try {
      await context.app.loadChannelMembers(widget.channelId);
    } catch (_) {
      if (mounted) setState(() => _loadFailed = true);
    }
  }

  ChannelRow? _channel() {
    for (final c in context.app.channels) {
      if (c.id == widget.channelId) return c;
    }
    return null;
  }

  /// 열어 둔 사이 채널이 사라지거나(삭제·비공개화·내보내짐) 남이 보관하면 닫고 알린다(designer).
  void _closeGone() {
    if (_closing) return;
    _closing = true;
    final messenger = ScaffoldMessenger.of(context);
    final text = context.t.chGone;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      Navigator.of(context).pop();
      messenger.showSnackBar(_snack(text));
    });
  }

  Future<bool> _confirm(String text, String ok, {bool danger = false}) async {
    final t = context.t;
    final k = context.tokens;
    final r = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        content: Text(text),
        actions: [
          TextButton(onPressed: () => Navigator.of(d).pop(false), child: Text(t.chCancel)),
          TextButton(
            key: const Key('channel-confirm-ok'),
            onPressed: () => Navigator.of(d).pop(true),
            style: danger ? TextButton.styleFrom(foregroundColor: k.danger) : null,
            child: Text(ok),
          ),
        ],
      ),
    );
    return r == true;
  }

  /// 성공하면 true — 밀어 내보내기는 이 값으로만 줄을 없앤다(security #1675 s2).
  Future<bool> _run(Future<void> Function() action) async {
    if (_busy) return false;
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    final failed = context.t.chActionFailed;
    try {
      await action();
      return true;
    } catch (_) {
      messenger.showSnackBar(_snack(failed));
      return false;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _archive(ChannelRow ch) async {
    final t = context.t;
    final to = !ch.isArchived;
    if (!await _confirm(to ? t.chArchiveConfirm : t.chUnarchiveConfirm, to ? t.chArchive : t.chUnarchive)) return;
    if (!mounted) return;
    _selfArchiving = true;
    await _run(() => context.app.updateChannel(ch.id, archived: to));
    _selfArchiving = false;
  }

  Future<void> _leave(ChannelRow ch) async {
    final t = context.t;
    final app = context.app;
    final me = app.me;
    if (me == null) return;
    if (!await _confirm(t.chLeaveConfirm, t.chLeave, danger: true)) return;
    if (!mounted) return;
    // 마지막 멤버면 한 번 더 묻는다(데스크톱과 같다). 명단은 새로 받는다 — 들고 있던 것이 낡았을 수 있다.
    List<ChannelMember> members;
    try {
      members = await app.loadChannelMembers(ch.id);
    } catch (_) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(_snack(t.chMembersLoadFailed));
      return;
    }
    if (!mounted) return;
    if (members.length == 1 && members.first.accountId == me.id) {
      if (!await _confirm(t.chLeaveLast, t.chLeaveAnyway, danger: true)) return;
      if (!mounted) return;
    }
    final nav = Navigator.of(context);
    var ok = false;
    await _run(() async {
      await app.removeChannelMember(ch.id, me.id);
      ok = true;
    });
    // 나간 채널 화면에 머물지 않는다 — 홈(탭 뿌리)으로.
    if (ok && mounted) nav.popUntil((r) => r.isFirst);
  }

  Future<void> _addMembers(ChannelRow ch, Set<String> current) async {
    final picked = await Navigator.of(context).push<List<String>>(
      MaterialPageRoute(builder: (_) => MemberPickerScreen(exclude: current)),
    );
    if (picked == null || picked.isEmpty || !mounted) return;
    final app = context.app;
    final messenger = ScaffoldMessenger.of(context);
    final t = context.t;
    var failed = 0;
    // 넣는 사이 커뮤니티를 바꾸면 멈춘다 — 남은 호출이 새 커뮤니티 서버로 옛 id 를 보내지 않게(security #1675 s1).
    final generation = app.sessionGeneration;
    await _run(() async {
      for (final id in picked) {
        if (app.sessionGeneration != generation) return;
        try {
          await app.addChannelMember(ch.id, id);
        } catch (_) {
          failed++;
        }
      }
    });
    if (failed > 0) messenger.showSnackBar(_snack(t.chMembersPartial('$failed')));
  }

  /// 확인을 받고 내보낸다. 서버가 받아들였을 때만 true.
  Future<bool> _removeMember(ChannelRow ch, ChannelMember m) async {
    final t = context.t;
    final name = '@${m.handle}';
    if (!await _confirm(t.chRemoveMemberConfirm(name), t.chRemoveMember, danger: true)) return false;
    if (!mounted) return false;
    return _run(() => context.app.removeChannelMember(ch.id, m.accountId));
  }

  /// 줄 탭 → 작은 시트 [내보내기](designer c3 — 밀기만으로는 숨은 동작이다).
  Future<void> _memberSheet(ChannelRow ch, ChannelMember m) async {
    final t = context.t;
    final k = context.tokens;
    final go = await showModalBottomSheet<bool>(
      context: context,
      useRootNavigator: true,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(title: Text('@${m.handle}', style: const TextStyle(fontWeight: FontWeight.w600))),
          ListTile(
            key: const Key('member-remove'),
            leading: Icon(Icons.person_remove_outlined, color: k.danger),
            title: Text(t.chRemoveMember, style: TextStyle(color: k.danger)),
            // 시트는 제 context 로 닫는다(#1368·#1390 교훈).
            onTap: () => Navigator.of(sheet).pop(true),
          ),
        ]),
      ),
    );
    if (go == true && mounted) await _removeMember(ch, m);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final k = context.tokens;
    final ch = _channel();
    if (ch == null) {
      if (!_closing) _closeGone();
      return const Scaffold();
    }
    // 남이 보관했다(보관 안 됨 → 됨, 내가 누른 것이 아님) — 보관된 채널은 읽기 전용이라 닫고 알린다.
    if (_wasArchived == false && ch.isArchived && !_selfArchiving) _closeGone();
    _wasArchived = ch.isArchived;

    final me = app.me;
    final canManage = me?.can('channel.manage') == true;
    final members = app.channelMembers[ch.id];
    final isMember = members != null && members.any((m) => m.accountId == me?.id);
    final canInvite = !ch.isArchived && members != null && (!ch.isPrivate || isMember);
    final canRemove = !ch.isArchived && me?.isAdmin == true;
    final sorted = [...?members]..sort((a, b) {
        final an = _who(app.accounts[a.accountId], a.handle).toLowerCase();
        final bn = _who(app.accounts[b.accountId], b.handle).toLowerCase();
        return an.compareTo(bn);
      });

    Widget chip(String label, {Key? key}) => Container(
          key: key,
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
          decoration: BoxDecoration(color: k.surfaceSunken, borderRadius: BorderRadius.circular(HarkroomRadius.pill)),
          child: Text(label, style: TextStyle(fontSize: HarkroomType.meta, color: k.fgMuted)),
        );

    Widget memberRow(ChannelMember m) {
      final a = app.accounts[m.accountId];
      final removable = canRemove && m.accountId != me?.id;
      final tile = ListTile(
        key: Key('channel-member-${m.accountId}'),
        leading: HarkroomAvatar(id: m.accountId, name: m.handle, size: HarkroomSize.avatarSmall),
        title: Row(children: [
          Flexible(child: Text(_who(a, m.handle), maxLines: 1, overflow: TextOverflow.ellipsis)),
          if (a?.isAgent == true) ...[
            const SizedBox(width: 6),
            Icon(Icons.smart_toy_outlined, size: 16, color: k.fgAgent, semanticLabel: t.chAgentBadge),
          ],
        ]),
        subtitle: a != null && a.displayName.isNotEmpty && a.displayName != a.handle ? Text('@${a.handle}') : null,
        onTap: removable ? () => _memberSheet(ch, m) : null,
      );
      if (!removable) return tile;
      // 밀기는 지름길(designer c3) — 한 번 묻는다. 스크린리더에는 같은 동작을 custom action 으로 준다.
      return Semantics(
        customSemanticsActions: {
          CustomSemanticsAction(label: t.chRemoveMember): () => _removeMember(ch, m),
        },
        child: Dismissible(
          key: Key('channel-member-dismiss-${m.accountId}'),
          direction: DismissDirection.endToStart,
          background: Container(
            color: k.dangerSurface,
            alignment: Alignment.centerRight,
            padding: const EdgeInsets.symmetric(horizontal: HarkroomSize.gutter),
            child: Text(t.chRemoveMember, style: TextStyle(color: k.danger)),
          ),
          // 확인·호출을 여기서 끝낸다 — 서버가 거절하면 줄을 남긴다(밀어 없앤 줄이 목록에 남지 않게, security #1675 s2).
          confirmDismiss: (_) => _removeMember(ch, m),
          child: tile,
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(channelLabel(ch), maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [
          if (canManage)
            TextButton(
              key: const Key('channel-info-edit'),
              onPressed: _busy
                  ? null
                  : () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ChannelEditScreen(channel: ch))),
              child: Text(t.chEdit),
            ),
          const SizedBox(width: 4),
        ],
      ),
      body: SafeArea(
        child: AbsorbPointer(
          absorbing: _busy,
          child: RefreshIndicator(
            onRefresh: _load,
            child: ListView(
              key: const Key('channel-info'),
              children: [
                if (_busy) const LinearProgressIndicator(minHeight: 2),
                Padding(
                  padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 12, HarkroomSize.gutter, 8),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(channelLabel(ch),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: HarkroomType.title, fontWeight: FontWeight.w600, color: k.fg)),
                    const SizedBox(height: 6),
                    ch.topic == null || ch.topic!.isEmpty
                        ? Text(t.chNoTopic, key: const Key('channel-info-no-topic'), style: TextStyle(color: k.fgSubtle))
                        : Text(ch.topic!, key: const Key('channel-info-topic'), style: TextStyle(color: k.fg)),
                    const SizedBox(height: 10),
                    Wrap(spacing: 6, runSpacing: 6, children: [
                      chip(ch.isPrivate ? t.chPrivate : t.chPublic, key: const Key('channel-info-visibility')),
                      if (ch.isArchived) chip(t.chArchived, key: const Key('channel-info-archived')),
                    ]),
                    if (ch.repo != null) ...[
                      const SizedBox(height: 10),
                      Row(children: [
                        Text(t.chRepo, style: TextStyle(fontSize: HarkroomType.meta, color: k.fgMuted)),
                        const SizedBox(width: 8),
                        Flexible(child: Text(ch.repo!, key: const Key('channel-info-repo'), overflow: TextOverflow.ellipsis)),
                      ]),
                    ],
                  ]),
                ),
                const Divider(),
                Padding(
                  padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 4, HarkroomSize.gutter, 4),
                  child: Text(
                    members == null ? t.chMembersCount('').trim() : t.chMembersCount('${members.length}'),
                    key: const Key('channel-info-members-head'),
                    style: TextStyle(fontSize: HarkroomType.meta, fontWeight: FontWeight.w600, color: k.fgMuted),
                  ),
                ),
                if (canInvite)
                  ListTile(
                    key: const Key('channel-info-add-member'),
                    leading: const Icon(Icons.person_add_alt),
                    title: Text(t.chAddMember),
                    onTap: () => _addMembers(ch, {for (final m in members) m.accountId}),
                  ),
                if (members == null && _loadFailed)
                  ListTile(
                    key: const Key('channel-info-members-failed'),
                    title: Text(t.chMembersLoadFailed),
                    trailing: TextButton(onPressed: _load, child: Text(t.chRetry)),
                  )
                else if (members == null)
                  const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()))
                else
                  for (final m in sorted) memberRow(m),
                const Divider(),
                if (canManage)
                  ListTile(
                    key: const Key('channel-info-archive'),
                    leading: Icon(ch.isArchived ? Icons.unarchive_outlined : Icons.archive_outlined),
                    title: Text(ch.isArchived ? t.chUnarchive : t.chArchive),
                    onTap: () => _archive(ch),
                  ),
                // 멤버 명단을 받았는데 내가 없으면 나가기를 세우지 않는다(데스크톱 `knownMember` 와 같다).
                if (members == null || isMember)
                  ListTile(
                    key: const Key('channel-info-leave'),
                    leading: Icon(Icons.logout, color: k.danger),
                    title: Text(t.chLeave, style: TextStyle(color: k.danger)),
                    onTap: () => _leave(ch),
                  ),
                const SizedBox(height: 24),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 채널 편집 — 이름·주제만(designer c4). 저장소는 정보 화면에 읽기로만 둔다.
class ChannelEditScreen extends StatefulWidget {
  const ChannelEditScreen({super.key, required this.channel});

  final ChannelRow channel;

  @override
  State<ChannelEditScreen> createState() => _ChannelEditScreenState();
}

class _ChannelEditScreenState extends State<ChannelEditScreen> {
  late final _name = TextEditingController(text: widget.channel.name);
  late final _topic = TextEditingController(text: widget.channel.topic ?? '');
  bool _busy = false;
  String? _nameError;

  @override
  void dispose() {
    _name.dispose();
    _topic.dispose();
    super.dispose();
  }

  bool get _nameOk => channelNamePattern.hasMatch(_name.text.trim());

  Future<void> _save() async {
    if (_busy || !_nameOk) return;
    final name = _name.text.trim();
    final topic = _topic.text.trim();
    // 바뀐 것만 싣는다 — 이름을 늘 실으면 서버가 매번 유니크 검사·감사 대상으로 삼는다(데스크톱과 같다).
    final nameChanged = name != widget.channel.name;
    final topicChanged = topic != (widget.channel.topic ?? '');
    final nav = Navigator.of(context);
    if (!nameChanged && !topicChanged) {
      nav.pop();
      return;
    }
    setState(() {
      _busy = true;
      _nameError = null;
    });
    final t = context.t;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await context.app.updateChannel(
        widget.channel.id,
        name: nameChanged ? name : null,
        topic: topicChanged ? topic : null,
      );
      if (mounted) nav.pop();
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        if (e.code == 'channel_name_taken') _nameError = t.chNameTaken;
      });
      if (_nameError == null) messenger.showSnackBar(_snack(t.chActionFailed));
    } catch (_) {
      if (!mounted) return;
      setState(() => _busy = false);
      messenger.showSnackBar(_snack(t.chActionFailed));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Scaffold(
      appBar: AppBar(
        title: Text(t.chEditTitle),
        actions: [
          TextButton(
            key: const Key('channel-edit-save'),
            onPressed: _busy || !_nameOk ? null : _save,
            child: Text(t.chSave),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: SafeArea(
        child: AbsorbPointer(
          absorbing: _busy,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 12, HarkroomSize.gutter, 24),
            children: [
              if (_busy) const LinearProgressIndicator(minHeight: 2),
              TextField(
                key: const Key('channel-edit-name'),
                controller: _name,
                autocorrect: false,
                enableSuggestions: false,
                inputFormatters: const [ChannelNameFormatter()],
                onChanged: (_) => setState(() => _nameError = null),
                decoration: InputDecoration(
                  labelText: t.chNameLabel,
                  prefixText: widget.channel.isPrivate ? '🔒 ' : '# ',
                  helperText: t.chNameRule,
                  helperMaxLines: 2,
                  errorText: _nameError ?? channelNameProblem(t, _name.text.trim()),
                  errorMaxLines: 2,
                ),
              ),
              const SizedBox(height: 20),
              TextField(
                key: const Key('channel-edit-topic'),
                controller: _topic,
                maxLength: 256,
                minLines: 1,
                maxLines: 4,
                decoration: InputDecoration(labelText: t.chTopic, counterText: ''),
              ),
              const SizedBox(height: 20),
              // 공개 범위는 읽기만(시안 v1 결정 7) — 되돌리기 어려운 일이라 데스크톱에 둔다.
              InputDecorator(
                key: const Key('channel-edit-visibility'),
                decoration: InputDecoration(labelText: t.chVisibility, enabled: false),
                child: Row(children: [
                  Expanded(
                    child: Text(widget.channel.isPrivate ? '🔒 ${t.chPrivate}' : '# ${t.chPublic}'),
                  ),
                  Text(t.chVisibilityDesktopOnly,
                      style: TextStyle(fontSize: HarkroomType.meta, color: context.tokens.fgMuted)),
                ]),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
