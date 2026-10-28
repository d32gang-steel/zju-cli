# cnlxq-cli · 计算机网络作业

浙江大学《计算机网络》课程在线作业系统（iMATHAS，`10.214.0.253/network/exercise`）的 CLI。

- 命令：**`cnhw`**（别名 `cnlxq`）
- 网络：**需要校内网或 VPN**
- 账号：课程系统独立账号（**不是**统一身份认证密码）
- 依赖：Node ≥ 20，无第三方包

> 接口逆向细节见 [api.md](api.md)，Agent 用法见 [SKILL.md](SKILL.md)，总说明书见 [../MANUAL.md](../MANUAL.md)。

## 安装与登录

```bash
cd cnlxq-cli
npm link

export CNHW_PASSWORD='...'
cnhw login --username 3xxxxxxxxx
cnhw status
```

也可导入浏览器会话：

```bash
cnhw login --cookie "PHPSESSID=..."
```

会话存 `~/.config/cnhw/session.json`（0600，只存 Cookie）。课程 ID 默认 `115`，可用 `--course` 或 `CNHW_CID` 覆盖。

## 命令

```bash
cnhw status                    # 连通性
cnhw courses                   # 我选修的课程
cnhw items                     # 课程页：资源链接 + 进度表
cnhw ddl [--all]               # 作业/实验 DDL + 已交/未交
cnhw show <assessmentId>       # 当前题、满分、输入字段、选项
cnhw gradebook                 # 成绩册
cnhw uploads                   # 已上传的实验报告
cnhw download <path> -o file   # 下载课件/实验模板
cnhw get <path> [--raw]        # 抓任意页面（GB2312 自动转 UTF-8）

# 写操作（默认 dry-run，必须显式 --yes）
cnhw upload <file> --report 3 [--yes]    # 上传实验报告（Lab 1-8）
cnhw answer <id>                          # 逐题作答（真实提交，最后一条算分）
cnhw answer <id> --value "20"             # 只交当前这题
cnhw reattempt <id> --yes                 # 重置测验（清空得分）
```

## 示例

```bash
$ cnhw ddl
截止              剩余             类型  作业                 状态
2026-11-08 07:59  11天10小时       作业  Exercise 4 (Chap 4)
2026-11-08 23:59  12天2小时        作业  作业4
2026-11-08 23:59  12天2小时        实验  Lab3                 未交
2026-11-22 23:59  26天2小时        实验  Lab4                 未交
```

```bash
$ cnhw show 1025
Exercise 4 (Chap 4)
满分: 100
无时间限制

ch4-2. A group of N stations share a 56-kbps pure ALOHA channel...
```

## 写操作说明

- `upload --yes` 会真正把报告传给老师，先 dry-run 确认文件名/大小/编号；
- `answer` 每提交一题都写入真实作答记录，系统规则是**最后一次答案算分**；
- `reattempt --yes` 会**清空**该测验所有得分；
- 题目是随机生成的，不要用 `--answers` 批量喂固定答案。

## 限制

- 年代久远的 PHP 系统（PHP 5.6 / GB2312 / 无 JSON API），所有数据靠解析 HTML；
- 题目一页一题，没有「查看全部题目」的入口，`show` 只读当前页；
- 页面结构变化会直接影响解析（`api.md` 有 DOM 约定，便于修）；
- 提交接口依赖页面字段（`qnN`、`verattempts`），不要手写请求。
