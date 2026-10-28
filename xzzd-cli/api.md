# 学在浙大（courses.zju.edu.cn）接口笔记

记录时间：2026-10。目标是说明「CLI 为什么这么写」，页面/接口改版时按这里排查。

## 1. 认证链路

```
GET  courses.zju.edu.cn/user/index
 302  identity.zju.edu.cn/auth/realms/zju/protocol/cas/login   (Keycloak broker, client=TronClass)
 303  identity.zju.edu.cn/auth/realms/zju/broker/cas-client/login
 303  zjuam.zju.edu.cn/cas/login?service=<keycloak endpoint>
 POST username + password
 302  → Keycloak → courses.zju.edu.cn（下发 session cookie）
```

关键点：

- 设置 `Accept: application/json` + `X-Requested-With: XMLHttpRequest` 后，未登录的 `/api/*` 返回 **401 JSON**，否则会 302 到 SSO。CLI 依赖这一点做健康检查。
- 会话 Cookie 有效期约 1 小时。

## 2. 口令加密（最容易踩坑）

`js/login/login.js` 调 `security.js`，**不是标准 PKCS#1 v1.5**：

```
password = raw_rsa( reverse(明文), 小端分块, 零填充 )
```

1. `password.split('').reverse()` 先整体反转；
2. `chunkSize = 2 × (模数 16 位字数 − 1)` 字节（512 位模数 → **62 字节/块**），不足补零；
3. 每块按**小端序**拼成 BigInt，做**无填充裸 RSA**（`powMod`）；
4. 每块转 hex（4 字符/16 位 digit），多块用空格连接。

公钥：`GET https://zjuam.zju.edu.cn/cas/v2/getPubKey` → `{modulus, exponent}`（hex）。
验证码：`GET /cas/v2/getKaptchaStatus`（返回 `true/false`，页面里的验证码节点始终存在，不能看 DOM 判断）。

> 实现见 `src/cas.js`；测试里有一个用真实 `security.js` 生成的黄金向量。

## 3. 端点实测（学生账号）

| 用途 | 请求 | 结果 |
| --- | --- | --- |
| 身份 | `GET /api/profile` | 200（`user_no`、`role`、`department`） |
| 身份 | `GET /api/user` | **403** 教师/管理员接口 |
| 课程 | `GET /api/my-courses?page=1&page_size=200` | 200，分页，`semester` 对象有时缺 `name` |
| 学期 | `GET /api/my-semesters` | 200（13 条，半学期是独立条目） |
| 学年 | `GET /api/my-academic-years` | 200 |
| 待办 | `GET /api/todos` | 200，`{todo_list}` |
| 课程详情 | `GET /api/courses/{id}` | 200，含 `modules` |
| 章节 | `GET /api/courses/{id}/modules` | 200 |
| 作业列表 | `GET /api/courses/{id}/homework-activities` | 200，`submitted`/`end_time` |
| 作业详情 | `GET /api/activities/{aid}` | 200（课程作用域版本 404） |
| 活动/课件 | `GET /api/courses/{id}/activities?sub_course_id=0` | 200（`material`/`page`/`web_link`） |
| 附件下载 | `GET /api/uploads/{uid}/url` | 200，返回 tcmedia 签名链接 |
| 公告 | `GET /api/courses/{id}/bulletins` | 200（`/announcements` 是 404） |
| 通知 | `GET /api/alert/messages` | 200，`{data:[]}`（`/notifications` 404） |
| 成绩 | `GET /api/courses/{id}/exam-scores` | 200 |
| 点名场次 | `GET /api/courses/{id}/modules/rollcalls` | 200 |
| 点名明细 | `GET /api/rollcall/{id}` | 200，含 `student_rollcalls` |
| 教师签到 | `GET /api/course/{id}/students_rollcalls` | **403** |
| 讨论区 | `GET /api/courses/{id}/discussions` | **500 HTML**（平台 bug） |

TronClass 命名坑：公告叫 `bulletins`、资料是 `activities` 的一种、通知在 `alert/messages`、签到路径是**单数** `course`。

## 4. 学期模型

`my-courses` 的 `semester` 对象不稳定（有时只有 `id`/`sort`），所以用 `semester_id` join `my-semesters`。

| 名称 | key | 含义 |
| --- | --- | --- |
| 2026-2027秋冬 | `2026-2027-1` | 整学期 |
| 2026-2027秋 | `2026-2027-1A` | 前半（半学期课） |
| 2026-2027冬 | `2026-2027-1B` | 后半 |
| 2026-2027春 / 夏 | `...-2A` / `...-2B` | 春夏两半 |
| 2025-2026短 | `...-4` | 短学期（次年 6 月） |

- 显示排序对齐站点的 `sort`（秋冬 > 秋 > 冬 > 春夏 > 春 > 夏 > 短）；
- 跨学期排序用**开学时间**（短学期在次年 6 月，用编号会排错）；
- `--current` 取最近已开学的 base，并包含同 base 的 A/B 半学期。

## 5. 作业与 DDL

- 列表接口返回 `submitted`（bool）、`end_time`、`score`（字符串）、`score_percentage`；
- 详情在 `/api/activities/{id}`，要求正文是 `data.description`（HTML）；
- `xdc ddl` 默认只扫当前学期，按 `due_at` 升序，`--pending` 过滤已交。

## 6. 错误与健康检查

`src/health.js` 把失败分类：

- `401` → `AUTH_REQUIRED`（会话问题）
- `403/404` → 权限/不存在（服务本身是活的）
- `502/503/504` → `SERVICE_UNAVAILABLE`（学校网关/后端挂了）
- `5xx + HTML` → `SERVER_ERROR`（Rails 错误页）
- 网络错误 → `NETWORK`

`xdc status` 对 `/api/profile` 和 `/api/my-courses` 做探测，返回 `platform: ok|degraded|down`。
