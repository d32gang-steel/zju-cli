---
name: cnhw
description: 查询/操作浙江大学计算机网络课程作业系统（iMATHAS，10.214.0.253/network/exercise）：课程、作业 DDL、题干、成绩册、实验报告上传、逐题作答。当用户提到「计网作业」「Online Homework」「10.214.0.253」或要查实验截止时间时使用。
---

# cnhw — 计网作业系统 CLI

老旧 iMATHAS 分支：PHP 5.6、GB2312、纯 HTML 表单，没有 JSON API。CLI 通过 Cookie + 表单模拟工作。

## 前置

必须在校内网/VPN。独立课程账号（**不是**统一身份认证密码）：

```bash
export CNHW_PASSWORD='...'
cnhw login --username 3240105437 --json
cnhw status --json          # 先确认可达
```

会话在 `~/.config/cnhw/session.json`（只存 Cookie）。也可 `cnhw login --cookie "PHPSESSID=..."` 导入浏览器会话。

## 只读命令（可自由调用）

```bash
cnhw courses --json                 # [{cid,name}]
cnhw items --json                   # {header, links[], schedule[]}
cnhw ddl --json                     # 作业/实验 DDL + submitted（due_at 为 ISO/UTC）
cnhw ddl --all --json
cnhw show 1025 --json               # 当前题、满分、answer_input、options、verattempts
cnhw uploads --json                 # {files[], reports[]}
cnhw gradebook --json               # 按表头转成对象
cnhw get "/course/listusers.php?cid=115"    # 任意页面（GB2312 自动转码）
```

`ddl` 的 `due_at` 是 UTC，展示时按 Asia/Shanghai 转换。题目一页一题且随机生成，`show` 只显示当前页。

## 写命令（必须先取得用户明确同意）

```bash
cnhw upload <file> --report <1-8>          # 默认 dry-run
cnhw upload <file> --report <1-8> --yes    # 真正上传，老师可见
cnhw answer <id>                            # 逐题交互，真实提交，最后一条算分
cnhw answer <id> --value "答案"             # 只交当前题
cnhw reattempt <id> --yes                   # 重置，会清空全部得分
```

**不要**用 `answer` 试探题目；空答案会覆盖最后一次作答。

## 输出契约

```json
{"ok":true,"count":1,"data":[...]}
{"ok":false,"error":{"code":"AUTH_REQUIRED","message":"会话已失效","hint":"重新运行 cnhw login"}}
```

退出码：0 成功 / 1 一般错误 / 2 未登录 / 4 网络 / 5 用法。

## 实现要点（排障用）

- 登录：`md5(md5(password + "@zju$#") + timestamp)`，`oldpass = md5(password)`
- 表单字段逐题变化：`qn0`、`qn1`…；单选是 `value=0/1/2`
- 必须回传页面里的 `verattempts`，否则同题重刷
- `reattempt` 要用 `showtest.php?reattempt=all`（不能带 cid/id）
- 课程页是「进度表 + 资源链接 + 作业卡片」，DDL 在卡片的 `Due ...` 里

完整说明见仓库根目录 `MANUAL.md`。
