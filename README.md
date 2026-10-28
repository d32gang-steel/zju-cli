# zju-cli

把浙大学生日常使用的线上服务，做成**适合人和 AI 调用的命令行工具**。

浙大的大多数服务只有网页端：没有公开 API、没有文档、页面结构还经常变。这个仓库按「一个网站一个目录」的方式，把登录、查询、导出这些重复操作固化成 CLI，并把逆向出来的接口细节记录在各自的 `api.md` 里。

> 非官方项目，仅供个人学习与效率工具使用。

## 已有工具

| 目录 | 服务 | 命令 | 能力 |
| --- | --- | --- | --- |
| [`xzzd-cli`](xzzd-cli/) | 学在浙大 `courses.zju.edu.cn` | `xdc`（别名 `xzzd`） | 登录、课程/学期、作业与 DDL、待办、点名与出勤、课件下载、成绩、公告、原始 API |
| [`cnlxq-cli`](cnlxq-cli/) | 计算机网络作业 `10.214.0.253/network/exercise` | `cnhw`（别名 `cnlxq`） | 登录、课程条目、作业/实验 DDL、题干、成绩册、实验报告上传、逐题作答 |

两个工具都：

- 零第三方依赖，只需要 Node ≥ 20；
- 非 TTY 自动输出 JSON，方便脚本和 Agent；
- 默认只读，写操作（提交/上传/答题）必须显式加 `--yes`；
- 会话保存在 `~/.config/<tool>/session.json`（0600，只存 Cookie）。

## 快速开始

```bash
git clone <this-repo> zju-cli && cd zju-cli

cd xzzd-cli && npm link && cd ..
cd cnlxq-cli && npm link && cd ..

# 学在浙大（统一身份认证）
export XD_USERNAME=3xxxxxxxxx
export XD_PASSWORD='...'
xdc login
xdc ddl

# 计网作业（独立课程账号，需校内网/VPN）
export CNHW_PASSWORD='...'
cnhw login --username 3xxxxxxxxx
cnhw ddl
```

不想 `npm link` 也可以直接用路径：`node xzzd-cli/bin/xdc.js ...`。

## 目录约定

```
zju-cli/
├── README.md            ← 你在这里：项目愿景与规范
├── MANUAL.md            ← 给 AI Agent 的总说明书（命令、契约、安全规则）
├── xzzd-cli/
│   ├── README.md        ← 网站、工具名、用法
│   ├── api.md           ← 接口探查记录（认证、端点、字段、坑）
│   ├── SKILL.md         ← Agent skill
│   ├── bin/ src/ test/
│   └── package.json
└── cnlxq-cli/
    ├── README.md
    ├── api.md
    ├── SKILL.md
    ├── bin/ src/ test/
    └── package.json
```

## 设计原则

1. **结构化输出优先**：默认 `{ok, count, data}`，错误 `{ok:false, error:{code,message,hint}}`，配套固定退出码。
2. **只读是默认值**：任何会写数据的操作都要 `--yes`，且默认 dry-run 打印将要发送的请求。
3. **零依赖**：只用 Node 内置能力（fetch / crypto / fs），避免供应链和安装问题。
4. **能诊断**：把「平台挂了」和「你没登录」分开（`status` / 错误码 / hint）。
5. **文档与代码同仓**：每个站点必须有 `README.md`（怎么用）和 `api.md`（怎么逆向出来的），方便下次页面改版时修复。

## 贡献

**新增网站 → 提 PR。** 建一个 `<服务缩写>-cli` 目录，PR 必须包含：

- `README.md`（网站、命令名、登录方式、用法、限制）；
- `api.md`（认证流程、端点实测、关键字段、已知的坑）；
- 可运行的 `bin/` + `src/`（零第三方依赖）和 `node:test` 单测 + mock 端到端；
- 根 README 工具表里的一行登记。

**API 变更 / 页面改版 → 提 issue。** 请附上：

- 出错的命令与完整报错（`code` / `message` / `hint`）；
- HTTP 状态码、脱敏后的响应片段或页面结构；
- 发生时间与所在网络（校内 / VPN / 公网）。

## 安全声明

**使用安全**

- **不保证安全。** 不保证每个工具都无毒无害。大众服务（如学在浙大）使用者多、相对可靠；小众或涉及敏感信息的服务，工具可能由作者写坏，也可能被第三方改动。使用时自行保持警惕，有疑虑可让 AI 逐行 review。工具也不保证随页面改版及时更新。
- **不负责错误提交。** 涉及提交作业、上传文件、填写表单等写操作时，请先用 dry-run 确认内容。因误提交、重复提交、覆盖作答等造成的后果，由使用者自行承担。同时，一切提交官网网站为准：受客观条件限制，工具不保证可提交可靠性。
- **不负责违规后果。** 请自行确认使用方式符合学校与课程的要求。因违反规定导致的账号限制、成绩影响或其他后果，作者不承担责任。

**提交安全**

提 issue 或 PR 时，不要携带账号密码、Cookie、学号、成绩单等个人信息；复现日志和截图请先脱敏。

**公开安全**

面向公网的服务（如 VPN 门户、学校官网），工具不要随意公开：这些系统任何人都能访问，公开工具会降低滥用门槛。公网工具如确需分享，建议采用内网链接分发：仓库中只放说明或空目录，实际代码与下载地址指向仅内网可达的位置，避免在公网直接获取。
