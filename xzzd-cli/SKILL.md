---
name: xdc-courses
description: 查询浙江大学「学在浙大」(courses.zju.edu.cn) 的课程、作业、待办、成绩、公告，并可直接调用其内部 API。当用户要查看/检索浙大课程作业、截止时间、课程列表，或需要登录学在浙大抓数据时使用。
---

# xdc — 学在浙大 CLI

## 何时用

用户提到「学在浙大」「courses.zju.edu.cn」「浙大作业/课程/DDL/待办/成绩」，或要求从该平台取数据时。

## 前置：登录

CLI 的会话存在 `~/.config/xdc-cli/session.json`，约 1 小时过期。优先让环境变量里带凭据，CLI 会自动续登：

```bash
export XD_USERNAME=3200100000
export XD_PASSWORD='...'
xdc status --json        # 平台是否可用（平台经常崩，先看这个）
xdc doctor --json        # 会话/身份/端点自检
```

若 `doctor` 显示 `unauthorized`，执行：

```bash
xdc login --json         # 交互输入（密码不回显）
```

SSO 触发验证码/二次验证时，密码流程会失败（`CAPTCHA` / `MFA_REQUIRED`），改用浏览器 Cookie：

```bash
xdc login --cookie "session=...; route=...; ..."   # 从 DevTools Network 的 Cookie 请求头复制
```

## 查询（全部支持 --json）

```bash
xdc courses --json                     # 全部课程：id / name / semester_key / instructor
xdc courses --json --current           # 当前学期（semester 由课程 code 推导，接口不给）
xdc courses --json --semester 2025-2026-2
xdc courses --json --fields id,name,semester_key   # 省 token
xdc semesters --json                   # 各学期门数 + current 标记
xdc assignments --json --limit 20      # 作业汇总，按 due_at 升序；含 due_in / overdue / submitted
xdc assignments --course 678 --json    # 单课程作业
xdc assignment 678 12345 --json        # 作业要求（正文/附件/状态）
xdc assignment 678 12345 --download ./hw
xdc submit 678 12345 --text "..."      # 默认 dry-run，--yes 才提交（接口未验证）
xdc ddl --json                         # 未提交作业 + DDL（默认当前学期）
xdc ddl --days 7 --json                # 只看 7 天内到期
xdc watch --once --json                # 单次扫描点名；去掉 --once 常驻盯
xdc todos --json                       # 待办
xdc semesters --json
xdc grades 678 --json
xdc announcements --course 678 --json     # 单课程公告
xdc announcements --all --json            # 全部课程公告聚合
xdc notifications --json --limit 10       # 通知
xdc materials 678 --json                  # 课件/资料列表
xdc materials 678 --download ./course678   # 下载课件（走签名链接）
xdc rollcall --course 678 --json          # 点名场次 + 本人状态（on_call_fine / absent）
xdc rollcall --all --json --limit 20      # 跨课程汇总（可加 --detail 逐场查本人状态）
```

## 输出契约

成功：stdout
```json
{"ok":true,"count":3,"data":[{...}]}
```
失败：stderr + 非零退出码
```json
{"ok":false,"error":{"code":"AUTH_REQUIRED","message":"...","hint":"..."}}
```

退出码：`0` 成功 · `2` 未登录 · `3` 不存在 · `4` 网络 · `5` 用法错误。
解析时始终检查 `ok`，不要只看退出码为 0 就假设字段齐全。

课程对象关键字段：`id`、`name`、`code`、`semester`、`semester_key`（`2026-2027-1`，可排序）、`academic_year`、`term`、`instructor`、`department`。

作业对象关键字段：`id`、`title`、`course`、`course_id`、`due_at`（ISO8601 UTC）、`due_in`（中文相对时间）、`overdue`、`submitted`、`status`、`score`、`max_score`。

列表信封里 `total` 是全量条数，`data` 可能因 `--page/--page-size` 被切片；需要全量时不要带分页参数。

## 需要平台没有封装的数据时

```bash
xdc discover --json                                   # 探测端点：status / keys / count
xdc api GET /api/courses/678/homework-activities --query page=1 --query page_size=5
xdc api GET /api/user --compact
```

`xdc api` 会带上会话 Cookie 与 XHR 头，返回 `{status, path, body}`。先 `discover` 找端点，再 `api` 取原始数据，必要时用 `--full` 看未裁剪字段。

## 平台故障

学在浙大会整站崩。`xdc status` 返回 `platform: "down"` 时，不要反复重试、也不要以为会话失效：

- `401/403/404` = 服务活着（权限/登录问题）；
- 网络错误、`5xx`、HTML 错误页 = 平台故障，命令会返回 `SERVICE_UNAVAILABLE` / `SERVER_ERROR`。

## 排查

```bash
xdc login --debug 2> login.log          # 请求/响应全量（Cookie、ticket 已脱敏）
xdc courses --debug --debug-full 2> api.log
```

stdout 始终是 JSON，调试信息只进 stderr，可以安全地 `> out.json`。

## 注意

- 不要循环高频调用；作业汇总默认并发 3、每课程分页 100。
- 只读为主，避免调用写接口（提交作业、签到等）；`rollcall` 刻意不提供自动签到。
- 时间统一按 `Asia/Shanghai` 解释；`due_at` 是 UTC，展示前转换。
