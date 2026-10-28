# 使用说明书（给 AI Agent / GPT）

本工作区有两个互不相关的 CLI，都面向浙江大学的课程系统：

| 工具 | 目标 | 命令 | 性质 |
| --- | --- | --- | --- |
| `xzzd-cli` | 学在浙大 `courses.zju.edu.cn` | `xdc`（别名 `xzzd`） | TronClass，有 JSON API |
| `cnlxq-cli` | 计网作业系统 `10.214.0.253/network/exercise` | `cnhw`（别名 `cnlxq`） | 老 iMATHAS，纯 HTML 表单 |

两个都只依赖 Node ≥ 20，无第三方包。**先读第 6 节「Agent 操作规则」再动手。**

---

## 1. 环境与安装

```bash
node -v            # 需要 >= 20
cd xzzd-cli   && npm link     # 或直接用 node bin/xdc.js
cd cnlxq-cli && npm link     # 或直接用 node bin/cnhw.js
```

不 `npm link` 也可以，把命令换成绝对/相对路径：

```bash
node xzzd-cli/bin/xdc.js status --json
node cnlxq-cli/bin/cnhw.js status --json
```

### 5 分钟自检

```bash
node xzzd-cli/bin/xdc.js status --json      # {"data":{"platform":"ok",...}}
node cnlxq-cli/bin/cnhw.js status --json   # {"data":{"reachable":true,...}}
```

`platform` 为 `down` 或 `reachable:false` 时，先解决网络/平台问题，不要继续重试。

网络要求：

- `xdc`（别名 `xzzd`）：公网可达 `courses.zju.edu.cn` 与 `identity.zju.edu.cn`
- `cnhw`（别名 `cnlxq`）：**必须在校内网或 VPN**（`10.214.0.253` 是内网地址）

---

## 2. 认证与配置

### 2.1 xdc（学在浙大）

浙大统一身份认证（CAS + Keycloak）。密码用前端 RSA（裸 RSA + 反转 + 小端分块）加密，CLI 已复刻。

```bash
export XD_USERNAME=3240105437
export XD_PASSWORD='...'
xdc login --json            # 或交互输入
```

- 会话：`~/.config/xdc-cli/session.json`（0600，只存 Cookie）
- 有效期约 1 小时；带 `XD_USERNAME/XD_PASSWORD` 时命令会**自动续登**
- SSO 触发验证码/二次验证时，改导 Cookie：
  ```bash
  xdc login --cookie "session=...; route=..."
  ```
- 兼容旧变量 `ZJU_*`

### 2.2 cnhw（计网作业）

独立课程账号（**不是**统一身份认证密码），md5 挑战：

```bash
export CNHW_USERNAME=3240105437
export CNHW_PASSWORD='...'
cnhw login --username 3240105437
```

- 会话：`~/.config/cnhw/session.json`（0600）
- 也可导入浏览器会话：`cnhw login --cookie "PHPSESSID=..."`
- 课程 ID 默认 `115`（`CNHW_CID` 或 `--course` 覆盖）

---

## 3. 命令参考

### 3.1 xdc（学在浙大）

```bash
xdc status                     # 平台健康检查（挂了会明确说平台挂，不是你没登录）
xdc doctor                     # 会话/身份/端点自检

xdc courses --current          # 当前学期课程（含半学期课）
xdc courses --semester 2025-2026-2 --json
xdc course 99468               # 课程详情 + 章节

xdc ddl                        # 未提交作业 + DDL（默认当前学期）
xdc ddl --days 7 --json        # 7 天内到期
xdc assignments --pending      # 全部课程的待交作业
xdc assignment 99468 1197762   # 作业要求（正文/附件/提交状态）
xdc assignment 99468 1197762 --download ./hw

xdc todos
xdc semesters
xdc grades 99468
xdc announcements --all
xdc notifications
xdc materials 93119 --download ./course93119
xdc rollcall --course 74260    # 点名场次 + 本人状态
xdc watch --once --json        # 扫当前进行中的点名

xdc api GET /api/profile       # 原始 API（探索用）
xdc discover                   # 端点探测
```

### 3.2 cnhw（计网作业）

```bash
cnhw status                    # 连通性
cnhw courses                   # 我选修的课程
cnhw items                     # 课程页：资源链接 + 进度表
cnhw ddl                       # 作业/实验截止时间 + 已交/未交
cnhw ddl --json                # {kind: assessment|homework|lab_report, submitted}
cnhw show 1025                 # 当前题/满分/表单字段
cnhw uploads                   # 已上传实验报告
cnhw gradebook                 # 成绩册
cnhw download "/network/download/.../实验报告模版_实验1.doc" -o lab1.doc

# 写操作（危险，见第 6 节）
cnhw upload lab3.zip --report 3          # 默认 dry-run
cnhw upload lab3.zip --report 3 --yes    # 真正上传
cnhw answer 1025                          # 逐题交互作答（真实提交）
cnhw answer 1025 --value "20"             # 只交当前题
cnhw reattempt 1025 --yes                 # 重置（清空得分）
```

---

## 4. 输出契约

两个 CLI 都遵循同一套：

**成功** → stdout

```json
{"ok": true, "count": 2, "data": [...]}
```

**失败** → stderr + 非零退出码

```json
{"ok": false, "error": {"code": "AUTH_REQUIRED", "message": "未登录", "hint": "运行 xdc login"}}
```

- 非 TTY（管道/Agent 调用）自动输出 JSON；TTY 下人读表格
- `--json` 强制 JSON；`--compact` 单行
- `--raw` 原样 HTML（仅 cnhw）；`--full` 原始对象（仅 xdc）

退出码：

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 一般错误 / 平台异常（`SERVER_ERROR`、`SERVICE_UNAVAILABLE`） |
| 2 | 未登录 / 凭据错误 |
| 3 | 资源不存在（仅 xdc） |
| 4 | 网络不可达 |
| 5 | 用法错误 |

---

## 5. 典型 JSON

`xdc ddl --json`：

```json
{"ok":true,"count":4,"data":[
  {"id":1197762,"title":"Lab 2: RV64 进程调度模拟","course":"操作系统",
   "due_at":"2026-11-05T15:59:00.000Z","due_in":"9天22小时",
   "submitted":false,"state":"pending","overdue":false}
]}
```

`cnhw ddl --json`：

```json
{"ok":true,"count":1,"data":[
  {"title":"Exercise 4 (Chap 4)","id":1025,"kind":"assessment",
   "due_text":"Sun 11/8/26, 7:59 am","due_at":"2026-11-07T23:59:00.000Z",
   "due_in":"11天13小时","summary":"第4次作业(Ch-4)"}
]}
```

`cnhw show 1025 --json`：

```json
{"ok":true,"data":{"title":"Exercise 4 (Chap 4)","points":100,
 "question":"ch4-2. A group of N stations ...","answer_input":"qn0",
 "options":[],"form_action":"showtest.php?action=shownext&score=0",
 "verattempts":"0","inputs":["qn0","verattempts"]}}
```

---

## 6. Agent 操作规则（重要）

1. **默认只读。** 读操作（`status/courses/items/ddl/show/gradebook/assignments/materials/rollcall`）可以自由调用。
2. **写操作必须先获得用户明确同意**：
   - `xdc submit`（提交作业文本，接口未验证）
   - `cnhw upload --yes`（上传实验报告，老师可见）
   - `cnhw answer`（每答一题都写入真实作答记录，**最后一条算分**）
   - `cnhw reattempt --yes`（**清空**已有得分）
3. `cnhw answer` 不要用来“试探题目”——题是随机的，且空答案会覆盖最后一次答案。要读题就用 `show`（只读当前页）。
4. **平台故障不要重试。** 看到 `SERVICE_UNAVAILABLE` / `SERVER_ERROR`，先 `xdc status`，确认是平台挂了就停，别循环打。
5. **凭据只从环境变量读**，不要写进日志、文件或回复里；也不要打印 `session.json`。
6. 不要抓取或转述其他学生的信息（`cnhw get "/course/listusers.php?cid=115"` 属于敏感操作）。
7. 输出给用户时保留原始 JSON 里的 `code/hint`，不要自己编造错误原因。

---

## 7. 常见任务配方

**查今天/本周要交什么（两个平台）**

```bash
xdc ddl --days 7 --json
cnhw ddl --json
```

**看某份作业要求**

```bash
xdc assignment 99468 1197762 --json          # 正文/附件/是否已交
cnhw show 1025 --json                       # 题干/满分/输入字段
```

**下载课件/实验模板**

```bash
xdc materials 93119 --download ./course93119
cnhw download "/network/download/.../实验报告模版_实验1.doc" -o lab1.doc
```

**上传实验报告（先 dry-run）**

```bash
cnhw upload lab3.zip --report 3            # 打印文件/大小/编号
cnhw uploads                                # 确认已上传列表
```

**盯点名**

```bash
xdc watch --once --json                    # 单次
xdc watch --interval 60                    # 常驻，响铃提醒
```

**平台是否挂了**

```bash
xdc status --json      # platform: ok|degraded|down
cnhw status --json
```

---

## 8. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `AUTH_REQUIRED` | 会话过期 | 重新 `login`（xdc 配了账号密码会自动续） |
| `BAD_CREDENTIALS` | 密码错 / 账号不通用 | cnhw 与统一身份认证**不是同一套密码** |
| `CAPTCHA` / `MFA_REQUIRED` | SSO 二次验证 | `xdc login --cookie "..."` |
| `SERVICE_UNAVAILABLE` / `SERVER_ERROR` | 平台挂了 | 停手，过一会 `status` 再看 |
| `NOT_JSON` | 返回登录页/错误页 | 会话失效或平台故障 |
| `cnhw`（别名 `cnlxq`） 连接失败 | 不在内网 | 连 VPN |
| 答案交了但页面没前进 | 缺 `verattempts` | 用当前版本 CLI（已修复） |
| 上传 404 | 缺 `--report` 或路径错 | `cnhw uploads` 看可选编号 |

---

## 9. 已知限制

- **xdc**：`/api/user` 对学生 403（用 `/api/profile`）；签到接口学生 403；会话 1 小时；平台经常 5xx；半学期（秋/冬）需要看 `semester_key` 的 `A/B` 后缀。
- **cnhw**：2010 年代的 iMATHAS 分支，PHP 5.6 / GB2312 / 无 JSON API；题目**一页一题且随机**；没有“查看全部题目”的入口；`answer` 会真实计分；`reattempt` 会清空得分。
- 两个工具的写接口都没有经过完整回归（`xdc submit` 未验证；`cnhw upload/answer` 已实测但依赖页面结构）。

---

## 10. 代码位置

```
xzzd-cli/      src/{http,cas,session,api,terms,health,debug,cli}.js   test/
cnlxq-cli/    src/{http,login,parse,cli}.js                          test/
```

各自 `npm test`；当前 38 / 19 个测试通过。
