# TieZ 本地补丁

Fork 自 [jimuzhe/tiez-clipboard](https://github.com/jimuzhe/tiez-clipboard) `v0.3.3` tag。
本文件汇总本 Fork 的全部本地改动；背景说明见 [README](./README.zh-CN.md)。

---

## 补丁一：搜索卡顿（FTS5 trigram 索引）

**分支**：`fts5-search-fix`

### 现象

搜索随输入实时触发，而上游用 `LIKE '%' || ? || '%'` 检索。SQLite 对这种写法
**无法使用索引**（右侧既非字面量、也不以通配符开头），必然全表扫描。
结果是：命中越少的词反而越慢 —— 无命中约 1.1 s，常见词约 2.1 s，
在 473 MB 的库上明显卡顿。

### 方案

改用 FTS5 external-content 表 + `trigram` 分词器建倒排索引，
并把 `search()` 拆成两阶段：FTS 先窄化候选 `id`，再回表取完整字段。

改动文件（7 个，约 +1270 / -205）：

| 文件 | 改动 |
|---|---|
| `infrastructure/repository/migrations.rs` | 新增 Migration 10：建 FTS5 表 + 3 个触发器；分批回填器 |
| `infrastructure/repository/clipboard_repo.rs` | `search()` 改为分发器；新增 `search_indexed` / `search_linear` / `search_sensitive_paged`；5 个回归测试 |
| `database.rs` | `PRAGMA mmap_size` / `cache_size`；FTS 状态读写、`fts_phrase`、后台回填 |
| `app/commands/history_cmd.rs` | 搜索命令改为 `async`，不再阻塞 UI 主线程 |
| `app/setup.rs` | 启动时挂后台回填 |
| `main.rs` | 移除 `tauri-plugin-http` 注册；崩溃报告器 + 启动看门狗 |
| `services/clipboard/utils.rs` | 修复上游 `mod tests` 重复定义（见补丁三） |

### 为什么这样切分查询

把 `content` / `html_content` 这类宽字段直接放进 `SELECT ... ORDER BY`，
SQLite 会生成 `USE TEMP B-TREE FOR ORDER BY`，把 351 MB 量级的数据灌进临时排序文件，
实测反而要 5–7 秒，比原来更慢。所以先用窄字段选出候选 `id`，
再只对这 ≤200 个 `id` 回表。

### 边界与注意事项

- **短词必须回退**：trigram 匹配不到少于 3 个 unicode 字符的子串，
  官方文档明确此时会退化为全表线性扫描。`len(term) < 3` 一律走 `LIKE`。
- **索引只是加速器**：候选集仍用 `LIKE` 复验，防止索引与内容短暂不一致。
- **用户输入不得直接拼进 MATCH**：`AND`/`OR`/`NOT`/`*`/`(`/`:` 均为操作符，
  统一用 `fts_phrase()` 包成转义引号短语。
- **UPDATE 触发器限定列**（`AFTER UPDATE OF content, source_app`）：
  否则每次 `use_count + 1` 都会重新分词整条大字段。

---

## 补丁二：启动失败（静默崩溃）

### 现象

双击 exe 后进程存在，但无窗口、无托盘、无任何日志。

### 根因

`tauri-plugin-http` 在 setup 阶段需要 `create_dir_all(app_cache_dir())`
并以 append 模式打开 `%LOCALAPPDATA%\com.tiez.app\.cookies`；
写不进去时整个 App **在写第一行日志之前**就退出。

该插件实际是死代码：前端没有任何地方引用 `@tauri-apps/plugin-http`，
capability 也未授予 `http:*`。移除注册即可消除该启动失败路径。

同时新增崩溃报告器与 20 秒看门狗 —— 原先 `windows_subsystem = "windows"`
二进制失败时完全静默，无法区分「卡住」与「已退出」。

---

## 补丁三：测试套件从未编译（上游遗留）

`services/clipboard/utils.rs` 中 `mod tests` 被定义了**两次**，导致
`E0428: the name 'tests' is defined multiple times`，**整个测试套件从来无法编译**。

改名为 `mod content_type_tests` 后测试终于可以运行：
`cargo test --release` → **73 通过 / 2 失败 / 1 忽略**。

> 修复前：编译失败，0 个测试能跑。
> 修复后：76 个测试可编译运行。剩余 2 个失败位于 `app/window_manager`，
> 属于既有问题，与本 Fork 的改动无关。

---

## 构建

```bash
npm install
npx tauri build --no-bundle
# 产物：src-tauri/target/release/tiez-app.exe
```

依赖：Node 18+、Rust (MSVC)、VS Build Tools（C++ 桌面开发负载）。无需 NSIS/WiX。

### ⚠️ 必须用 Tauri CLI，不要用 `cargo build`

裸跑 `cargo build --release` 会产出一个**不含前端资源的空壳 exe**：
`tauri-build` 依据 `DEP_TAURI_DEV` 判断 dev/release，而该变量只有 Tauri CLI 会传，
缺失时走 dev 分支、跳过资源嵌入。程序能启动、有窗口，只是显示
`localhost 拒绝连接`。**这个过程不报任何错。**

部署前断言：

```powershell
$a = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes('tiez-app.exe'))
$a.Contains('assets/index-')     # 必须为 True
```

---

## 补丁四：鼠标滚轮修复（Windows）

修复：快捷键/鼠标热键呼出主窗口后，**鼠标滚轮无法滚动列表**（触摸板双指正常），
以及滚轮**穿透到底下应用**的问题（上游 [issue #1](https://github.com/jimuzhe/tiez-clipboard/issues/1)）。

### 根因

主窗口以"不抢焦点"方式呼出（`set_focusable(false)` + `WS_EX_NOACTIVATE` + `SW_SHOWNA`），
保持用户输入焦点在原应用——这是产品特性。但 Windows 把：

- **鼠标滚轮** `WM_MOUSEWHEEL` 投递给**键盘焦点窗口**；
- **触摸板** `WM_POINTERWHEEL` 按光标下 hit-test 投递。

于是无焦点时滚轮消息全部发给了前台的其他应用：表现为 TieZ 滚不动（或穿透），
触摸板正常。托盘点击呼出正常是因为托盘路径显式调用了 `set_focus()`。

### 修复方式（不改变"不抢焦点"设计）

`WH_MOUSE_LL` 低级鼠标钩子在系统路由前拦截滚轮事件：光标命中主窗口树时，
把 `WM_MOUSEWHEEL` 直接投递给 `WindowFromPoint` 命中的 WebView2 子窗口并吞掉；
否则放行。同时过滤 `LLMHF_INJECTED`（不吞 AutoHotkey 等工具注入的滚轮），
并重建 wParam 中的 Ctrl/Shift 修饰键（保留 Ctrl+滚轮等语义）。

### 改动文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/infrastructure/windows_ext.rs` | 新增 `install_wheel_forward_hook()` 与 `wheel_ll_proc()`（约 +60 行） |
| `src-tauri/src/app/setup.rs` | `setup_main_window` 内安装钩子（1 行调用） |

### 已知边界

- 若 TieZ 主线程长时间卡顿，Windows 可能静默摘除低级钩子（修复失效但不影响稳定性），
  重启 TieZ 恢复。
- 窗口边缘纯透明区域的滚轮现在会被 TieZ 消费（此前穿透给底层应用）。

---

## 补丁五：自定义背景四角留白/圆弧交错（2026-10-17，2026-10-23 重做）

### 现象

主题为 `mica`/`acrylic` 且设置了自定义背景图时，窗口四角出现大小不一致的
交叠圆弧与浅色方块，背景图无法与窗口完美贴合。

### 根因（实测定位）

角部同时存在 **两个互不相同的圆角来源**：

1. CSS 壳层 `#root` 用 `--shell-radius`（mica 为 10 逻辑 px）裁切，同时
   `base.css` 给 `html`、`body` 也加了同样的 `border-radius` + `overflow: hidden`；
2. Windows 11 的 DWM 以系统固定半径（约 8 物理 px）裁切窗口轮廓，而 mica/acrylic
   背景板按**窗口矩形**整块绘制。

CSS 的弧比 DWM 的弧更大，两条弧之间的那条夹缝**谁都盖不到**：露出的是原生背景板，
于是四角各出现一块浅色楔形/方块，背景图也永远到不了窗口边缘。

### 方案：单一圆角来源（纯 CSS）

自定义背景生效时，把 CSS 一侧的圆角全部收平，让 DWM 成为唯一的圆角来源：

```css
body.has-custom-bg.windows-11.theme-mica #root,
body.has-custom-bg.windows-11.theme-mica::before,
html.has-custom-bg.windows-11.theme-mica,
html.has-custom-bg.windows-11.theme-mica > body... { border-radius: 0; }
```

`html` 与 `body` 必须一起收平 —— `base.css` 给两者都设了圆角 + `overflow: hidden`，
只改其一仍会被另一个裁回旧弧。未启用自定义背景时不改动，原生 mica/acrylic 行为不变
（此时夹缝两侧同色，本来就看不出来）。

### 为什么不用之前那版后端方案

上一版曾新增 `set_custom_background_state` 命令，在启用自定义背景时切
`DWMWCP_DONOTROUND` 并关闭 DWM 背景板/阴影。实测有两个缺陷，已全部回退：

1. **`window_vibrancy::clear_vibrancy` 在 Windows 上是空操作**——该函数只实现
   macOS（`window-vibrancy/src/lib.rs` 的 `clear_vibrancy` 仅匹配 `AppKit`），
   所谓的"清除 DWM 背景板"根本没发生；
2. 更严重的是 `set_shadow()` / DWM 属性调用会经
   `tauri-runtime-wry` 的 `send_user_message` 回到 tao 事件循环，在
   `setup`/命令回调中同步触发属于**重入**，引发了启动期 panic 与窗口纯白。
   `tauri::command` 默认在主线程同步执行，正是这条路径。

纯 CSS 方案没有跨线程/重入风险，行为确定且可像素级验证，因此最终采用。

### 验证

同进程、同数据、同 DPI 内做受控 A/B（CDP 注入旧圆角几何再移除）：

- 修复前：`html/body/#root` = `10px`、背景层 = `11px` → 四角各见一块白色楔形；
- 修复后：四者均为 `0px`，四角干净，背景图铺满到窗口边缘。

另外确认真实中文路径背景（`美术与绘画艺术.library/...`，2800×1260）经 asset
协议可正常加载并渲染。

### 改动文件

| 文件 | 改动 |
|---|---|
| `styles/themes/mica.css` / `acrylic.css` | 自定义背景 + Win11 时收平 CSS 圆角 |
| `shared/hooks/useCustomBackground.ts` | 同时给 `<html>` 打 `has-custom-bg` 标记 |

---
## 补丁六：安全与质量批量修复（2026-10-17）

全量代码审查记录见 `docs/CODE-REVIEW-FINDINGS.md` 与 `docs/review/`。
本批实现的安全/正确性/性能修复：

| 类别 | 修复 |
|---|---|
| 安全 | LAN 文件传输：文件名/upload_id 消毒（防路径穿越）、下载 token 改为 UUID、请求体限 256MB（`file_transfer/handlers.rs`、`mod.rs`） |
| 安全 | URL 打开改用 `ShellExecuteW`，消除 `cmd /C start` 剪贴板内容命令注入（`content_handler.rs`） |
| 安全 | CF_HDROP 解析按 `GlobalSize` 限界，杜绝畸形剪贴板载荷越界读（`win_clipboard.rs`） |
| 安全 | 旧版残留清理仅删除注册表证实且含旧程序二进制目录，不再按名字猜删（`migration.rs`） |
| 正确性 | `app.sound_paste_enabled` 此前写入 `delete_after_paste` 状态位（`settings_cmd.rs`） |
| 正确性 | 会话条目负 ID 改为单调生成器，修复同毫秒冲突（`services/mod.rs` 等 3 处） |
| 架构 | `image_ext_from_bytes` 三份重复收敛到 `infrastructure`，同时消除 infrastructure→commands 反向依赖 |
| 性能 | `clear_clipboard_history` 的 VACUUM 移到后台线程（`history_cmd.rs`） |
| 性能 | 前端：修复 `memo(ClipboardItem)` 比较器缺项；`LabelWithHint` 提升到模块级避免设置组反复重挂载 |
| 测试 | 修正 `window_manager` 两个与实现不符的单元测试期望值（此前 73 通过 / 2 失败） |
