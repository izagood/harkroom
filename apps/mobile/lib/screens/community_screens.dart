import 'package:flutter/material.dart';

import '../api/api_error.dart';
import '../connect/server_url.dart';
import '../i18n/i18n.dart';
import '../session/session_store.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../ui/parts.dart';
import '../ui/states.dart';
import '../ui/tokens.dart';

/// 여러 커뮤니티(designer 설계 harkroom://message/30621120-f955-4f07-8f23-9f1837ab99cd, M1 = ③⑧⑨).
///
/// 용어는 데스크탑 레일과 같은 "커뮤니티"다. 이 기기에 로그인해 둔 서버 하나가 커뮤니티 하나다 —
/// 열쇠는 계정 id 다(`session_store.dart`).

/// 커뮤니티 타일 — 이니셜 + 커뮤니티마다 다른 색. 색은 **계정 id 로** 고른다(이름은 바뀐다).
class CommunityTile extends StatelessWidget {
  const CommunityTile({super.key, required this.community, this.size = 36});

  final StoredCommunity community;
  final double size;

  @override
  Widget build(BuildContext context) =>
      HarkroomAvatar(id: community.accountId, name: community.displayLabel, size: size);
}

/// 그 커뮤니티로 옮기고, 옮겼으면 2초 토스트(designer 판정 5 — 이름과 내 핸들을 함께).
///
/// 먼저 맨 아래 화면까지 걷는다: 옮기는 동안 앞 커뮤니티의 화면(커뮤니티 상세·스레드)이 위에
/// 남아 있으면 새 커뮤니티의 상태로 옛 화면을 그린다.
///
/// [toChannels] 면 채널 탭으로 간다(머리 타일의 전환 시트, 설계 ④). 나 탭·커뮤니티 화면에서 옮기면
/// 사람은 목록을 관리하는 중이므로 탭을 그대로 둔다(designer #1046).
Future<void> enterCommunity(BuildContext context, String key, {bool toChannels = false}) async {
  final app = AppScope.read(context);
  if (toChannels) app.selectTab(0);
  final messenger = ScaffoldMessenger.of(context);
  final t = context.t;
  final margin = toastMargin(context);
  Navigator.of(context).popUntil((r) => r.isFirst);
  if (!await app.switchTo(key)) return;
  showSwitchedToast(messenger, t, app.activeCommunity!, app.me?.handle, margin);
}

void showSwitchedToast(
  ScaffoldMessengerState messenger,
  Strings t,
  StoredCommunity community,
  String? handle,
  EdgeInsets margin,
) {
  messenger
    ..removeCurrentSnackBar()
    ..showSnackBar(SnackBar(
      key: const Key('community-switched-toast'),
      content: Text(t.communitySwitched
          .replaceAll('{name}', community.displayLabel)
          .replaceAll('{handle}', handle ?? community.handle)),
      behavior: SnackBarBehavior.floating,
      margin: margin,
      duration: const Duration(seconds: 2),
    ));
}

/// 추가 화면을 띄우고, 로그인했으면 그 커뮤니티로 옮긴다. ✕ 로 닫으면 아무것도 바뀌지 않는다
/// (designer 판정 3 — 원래 커뮤니티 화면 그대로).
///
/// [initialUrl] 은 만료된 커뮤니티의 「다시 로그인」이 주소를 채워 둘 때 쓴다.
Future<void> openAddCommunity(BuildContext context, {String? initialUrl}) async {
  final added = await Navigator.of(context).push<StoredCommunity>(MaterialPageRoute(
    fullscreenDialog: true,
    builder: (_) => AddCommunityScreen(initialUrl: initialUrl),
  ));
  if (added == null || !context.mounted) return;
  await enterCommunity(context, added.key);
}

/// 서버 주소와 로그인을 **한 장에** 받는다(③). 지금 커뮤니티는 로그인된 채 남는다.
class AddCommunityScreen extends StatefulWidget {
  const AddCommunityScreen({super.key, this.initialUrl});

  /// 채워 두면 「다시 로그인」이다 — 제목이 바뀌고 주소 칸은 고칠 수 없다(designer 2). 주소를 바꾸고
  /// 싶으면 그것은 다른 커뮤니티이므로 「커뮤니티 추가」로 간다.
  final String? initialUrl;

  @override
  State<AddCommunityScreen> createState() => _AddCommunityScreenState();
}

class _AddCommunityScreenState extends State<AddCommunityScreen> {
  late final _url = TextEditingController(text: widget.initialUrl ?? '');
  final _loginId = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  ServerUrlProblem? _urlProblem;

  bool get _fixedUrl => widget.initialUrl != null;

  /// 로그인 실패 사유 — 키로 든다(화면이 문장을 짓지 않는다).
  String? _errorKey;

  @override
  void dispose() {
    _url.dispose();
    _loginId.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final url = validateServerUrl(_url.text);
    setState(() {
      _urlProblem = url.problem;
      _errorKey = null;
    });
    if (!url.isOk) return;
    setState(() => _busy = true);
    try {
      final added =
          await context.app.addCommunity(url.normalized!, _loginId.text.trim(), _password.text);
      if (mounted) Navigator.of(context).pop(added);
    } on ApiError catch (e) {
      // 로그인 화면과 같은 판단: 왜 틀렸는지는 말하지 않는다.
      setState(() => _errorKey =
          e.isCredentialFailure ? 'loginErrorRejected' : 'loginErrorUnreachable');
    } on Object {
      setState(() => _errorKey = 'loginErrorUnreachable');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _urlMessage(Strings t, ServerUrlProblem p) => switch (p) {
        ServerUrlProblem.empty => t.connectErrorEmpty,
        ServerUrlProblem.malformed => t.connectErrorMalformed,
        ServerUrlProblem.insecure => t.connectErrorInsecure,
      };

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final problem = _urlProblem;
    final errorKey = _errorKey;
    return Scaffold(
      key: const Key('community-add'),
      appBar: AppBar(
        automaticallyImplyLeading: false,
        leading: IconButton(
          key: const Key('community-add-close'),
          tooltip: t.communityAddClose,
          icon: const Icon(Icons.close),
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: Text(widget.initialUrl == null ? t.communityAdd : t.communityExpired),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            TextField(
              key: const Key('community-add-url'),
              controller: _url,
              readOnly: _fixedUrl,
              autocorrect: false,
              keyboardType: TextInputType.url,
              textInputAction: TextInputAction.next,
              // 고칠 수 없는 칸은 고칠 수 있는 칸과 **다르게 생겨야** 한다 — 똑같으면 눌러도 아무 일이
              // 없어 고장 난 것처럼 보인다(designer #1046 후속). 옅은 바탕·테두리 없음·자물쇠.
              decoration: InputDecoration(
                labelText: t.connectServerUrlLabel,
                hintText: t.connectServerUrlHint,
                errorText: problem == null ? null : _urlMessage(t, problem),
                filled: _fixedUrl,
                fillColor: _fixedUrl ? context.tokens.soft : null,
                border: _fixedUrl ? InputBorder.none : null,
                enabledBorder: _fixedUrl
                    ? OutlineInputBorder(
                        borderRadius: BorderRadius.circular(8),
                        borderSide: BorderSide.none,
                      )
                    : null,
                focusedBorder: _fixedUrl
                    ? OutlineInputBorder(
                        borderRadius: BorderRadius.circular(8),
                        borderSide: BorderSide.none,
                      )
                    : null,
                suffixIcon: _fixedUrl
                    ? Icon(Icons.lock_outline,
                        key: const Key('community-add-url-locked'),
                        size: 18,
                        color: context.tokens.mute)
                    : null,
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('community-add-login-id'),
              controller: _loginId,
              autocorrect: false,
              enableSuggestions: false,
              textInputAction: TextInputAction.next,
              decoration: InputDecoration(labelText: t.loginIdLabel),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('community-add-password'),
              controller: _password,
              obscureText: true,
              textInputAction: TextInputAction.go,
              onSubmitted: (_) => _submit(),
              decoration: InputDecoration(labelText: t.loginPasswordLabel),
            ),
            if (errorKey != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  errorKey == 'loginErrorRejected' ? t.loginErrorRejected : t.loginErrorUnreachable,
                  key: const Key('community-add-error'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            const SizedBox(height: 20),
            FilledButton(
              key: const Key('community-add-submit'),
              onPressed: _busy ? null : _submit,
              child: Text(_busy ? t.commonLoading : t.communityAddSubmit),
            ),
          ],
        ),
      ),
    );
  }
}

/// 커뮤니티 하나(⑨): 표시 이름·계정·서버·버전, 옮기기·로그아웃.
class CommunityDetailScreen extends StatefulWidget {
  const CommunityDetailScreen({super.key, required this.communityKey});

  /// [StoredCommunity.key] — origin + 계정 id.
  final String communityKey;

  @override
  State<CommunityDetailScreen> createState() => _CommunityDetailScreenState();
}

class _CommunityDetailScreenState extends State<CommunityDetailScreen> {
  Future<String?>? _version;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_version != null) return;
    final c = _find(AppScope.read(context));
    if (c != null) _version = AppScope.read(context).serverVersionOf(c);
  }

  StoredCommunity? _find(AppState app) {
    for (final c in app.communities) {
      if (c.key == widget.communityKey) return c;
    }
    return null;
  }

  Future<void> _rename(StoredCommunity c) async {
    final t = context.t;
    final app = AppScope.read(context);
    final controller = TextEditingController(text: c.label ?? '');
    final next = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(t.communityLabel),
        content: TextField(
          key: const Key('community-label-field'),
          controller: controller,
          autofocus: true,
          decoration: InputDecoration(hintText: c.displayLabel, helperText: t.communityLabelHint),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: Text(t.communityCancel)),
          TextButton(
            key: const Key('community-label-save'),
            onPressed: () => Navigator.of(ctx).pop(controller.text),
            child: Text(t.communitySave),
          ),
        ],
      ),
    );
    controller.dispose();
    if (next != null) await app.renameCommunity(c.key, next);
  }

  Future<void> _signOut(StoredCommunity c) async {
    final app = AppScope.read(context);
    final nav = Navigator.of(context);
    if (c.key != app.activeKey) {
      await app.signOutCommunity(c.key);
      if (nav.mounted) nav.pop();
      return;
    }
    // 지금 커뮤니티를 빼면 다음 커뮤니티로 옮긴다 — 옮겼다는 것을 토스트로 말한다.
    final messenger = ScaffoldMessenger.of(context);
    final t = context.t;
    final margin = toastMargin(context);
    nav.popUntil((r) => r.isFirst);
    await app.signOutCommunity(c.key);
    final now = app.activeCommunity;
    if (now != null && app.me != null) showSwitchedToast(messenger, t, now, app.me!.handle, margin);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final app = context.app;
    final c = _find(app);
    if (c == null) return const Scaffold();
    final isCurrent = c.key == app.activeKey;

    return Scaffold(
      key: const Key('community-detail'),
      appBar: AppBar(title: ScreenTitle(title: c.displayLabel)),
      body: SafeArea(
        child: ListView(
          children: [
            ListTile(
              key: const Key('community-label'),
              title: Text(t.communityLabel),
              subtitle: Text(c.displayLabel),
              trailing: const Icon(Icons.edit_outlined, size: 18),
              onTap: () => _rename(c),
            ),
            ListTile(title: Text(t.communityAccount), subtitle: Text('@${c.handle}')),
            ListTile(title: Text(t.communityServer), subtitle: Text(c.baseUrl)),
            ListTile(
              title: Text(t.communityVersion),
              subtitle: FutureBuilder<String?>(
                future: _version,
                builder: (_, snap) => Text(snap.connectionState != ConnectionState.done
                    ? t.commonLoading
                    : (snap.data ?? t.communityVersionUnknown)),
              ),
            ),
            const Divider(),
            if (c.isExpired)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: FilledButton(
                  key: const Key('community-relogin'),
                  onPressed: () => openAddCommunity(context, initialUrl: c.baseUrl),
                  child: Text(t.communityExpired),
                ),
              )
            else if (!isCurrent)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: FilledButton(
                  key: const Key('community-switch'),
                  onPressed: () => enterCommunity(context, c.key),
                  child: Text(t.communitySwitchTo),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
              child: TextButton(
                key: const Key('community-sign-out'),
                style: TextButton.styleFrom(foregroundColor: k.err),
                onPressed: () => _signOut(c),
                child: Text(t.communitySignOutOne.replaceAll('{name}', c.displayLabel)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 채널 탭 머리 왼쪽(설계 ①): 지금 커뮤니티 타일 + 이름 ▾. 다른 커뮤니티에 나를 기다리는 것이
/// 있으면 타일에 주황 점 하나 — 수는 시트에서 본다(데스크탑 레일과 같다).
class CommunityHeader extends StatelessWidget {
  const CommunityHeader({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final k = context.tokens;
    final c = app.activeCommunity!;
    final t = context.t;
    // 스크린리더에는 「커뮤니티 전환, acme」 — 이름만 읽히면 무엇을 하는 버튼인지 모른다. 점은 그림이라
    // 읽히지 않으므로 뜻을 말로 붙인다(designer #1056).
    final label = t.communitySwitcherLabel.replaceAll('{name}', c.displayLabel) +
        (app.othersWaiting ? t.communityOthersWaiting : '');
    return Semantics(
      key: const Key('community-header-semantics'),
      button: true,
      label: label,
      // `excludeSemantics` 는 아래 InkWell 의 탭 동작까지 버린다 — 그대로 두면 VoiceOver 가 「버튼」이라 읽고도
      // 두 번 눌러 열리지 않는다(designer #1056). 탭을 여기서 다시 단다.
      onTap: () => showCommunitySwitcher(context),
      excludeSemantics: true,
      child: InkWell(
      key: const Key('community-header'),
      borderRadius: BorderRadius.circular(8),
      onTap: () => showCommunitySwitcher(context),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Stack(
              clipBehavior: Clip.none,
              children: [
                CommunityTile(community: c, size: 28),
                if (app.othersWaiting)
                  Positioned(
                    right: -3,
                    top: -3,
                    child: Container(
                      key: const Key('community-header-dot'),
                      width: 10,
                      height: 10,
                      decoration: BoxDecoration(
                        color: k.accent,
                        shape: BoxShape.circle,
                        border: Border.all(color: k.bg, width: 2),
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                c.displayLabel,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                    fontSize: HarkroomType.screenTitle, fontWeight: FontWeight.w700, color: k.fg),
              ),
            ),
            Icon(Icons.expand_more, size: 20, color: k.mute),
          ],
        ),
      ),
      ),
    );
  }
}

/// 전환 시트(설계 ②). 행마다 타일·이름·`@핸들 · 호스트`, 지금 것 ✓, 다른 것은 기다리는 수, 만료는
/// 「다시 로그인」. 아래에 ＋추가와 ⚙관리.
Future<void> showCommunitySwitcher(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (sheet) => const _CommunitySwitcher(),
  ).then((_) {});
}

class _CommunitySwitcher extends StatelessWidget {
  const _CommunitySwitcher();

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final app = context.app;
    // 시트를 닫은 뒤에 쓸 맥락 — 시트의 context 는 닫히면 죽는다.
    final root = Navigator.of(context, rootNavigator: true).context;

    void close() => Navigator.of(context).pop();

    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.8),
        child: ListView(
          key: const Key('community-switcher'),
          shrinkWrap: true,
          padding: const EdgeInsets.only(top: 8, bottom: 8),
          children: [
            SectionHeader(label: t.meCommunitiesSection),
            for (final c in app.communities)
              ListTile(
                key: Key('switcher-${c.key}'),
                leading: CommunityTile(community: c),
                title: Text(c.displayLabel, maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text(
                  c.isExpired
                      ? t.communityExpiredSubtitle
                      : '@${c.handle} · ${Uri.tryParse(c.baseUrl)?.host ?? c.baseUrl}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: c.isExpired
                    ? ExpiredChip(label: t.communityExpired)
                    : c.key == app.activeKey
                        ? Icon(Icons.check, color: k.accent, semanticLabel: t.communityCurrent)
                        : UnreadBadge(count: app.otherWaiting[c.key] ?? 0),
                onTap: () {
                  close();
                  if (c.isExpired) {
                    openAddCommunity(root, initialUrl: c.baseUrl);
                  } else if (c.key != app.activeKey) {
                    enterCommunity(root, c.key, toChannels: true);
                  }
                },
              ),
            const Divider(),
            ListTile(
              key: const Key('switcher-add'),
              leading: const SizedBox(width: 36, child: Icon(Icons.add)),
              title: Text(t.communityAdd),
              onTap: () {
                close();
                openAddCommunity(root);
              },
            ),
            ListTile(
              key: const Key('switcher-manage'),
              leading: const SizedBox(width: 36, child: Icon(Icons.settings_outlined)),
              title: Text(t.communityManage),
              onTap: () {
                close();
                app.selectTab(2);
              },
            ),
          ],
        ),
      ),
    );
  }
}

/// 만료 상태 칩 — warn 바탕. ✓(지금 커뮤니티)의 강조색과 갈라 놓는다(designer #1046).
class ExpiredChip extends StatelessWidget {
  const ExpiredChip({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: k.warnSoft, borderRadius: BorderRadius.circular(999)),
      child: Text(label,
          style: TextStyle(color: k.warn, fontSize: 12, fontWeight: FontWeight.w600)),
    );
  }
}
