# 计算机网络作业系统 接口笔记

站点：`http://10.214.0.253/network/exercise/`（iMATHAS 定制版，校内网）
记录时间：2026-10。页面改版时按这里排查。

## 1. 技术栈与年代

| 项 | 值 |
| --- | --- |
| Server | Apache 2.4.28 (Win64) + PHP 5.6.31 |
| 编码 | `text/html; charset=gb2312` |
| 文档模式 | XHTML 1.0 Transitional + table 布局 |
| 前端 | 内联 JS + `javascript/md5.js`（Last-Modified 2007） |
| 数据接口 | **无**，全部服务端渲染表单 |

iMATHAS 是 2006 年前后的开源教学系统；这个部署约 2018 年，之后再没升级。

## 2. 登录

登录页内联 JS：

```js
pass_md5    = md5( md5(password + '@zju$#') + timestamp );
oldpass_md5 = md5(password);
```

- 盐 `@zju$#` 硬编码；
- `timestamp` 是隐藏字段（服务端时间，防重放）；
- POST 到同一个 `course/course.php?cid=...`，字段：`username`、`password`、`oldpass`、`timestamp`、`tzoffset`、`access=1`、`mathdisp=0`、`graphdisp=0`、`isok=1`；
- 会话是 `PHPSESSID`；
- 失败返回带 `Login Error` 的登录页；账号体系与统一身份认证无关。

## 3. 路由

| 路径 | 用途 | 学生 |
| --- | --- | --- |
| `/index.php` | 课程列表 | ✅ |
| `/course/course.php?cid=115&folder=0` | 课程页（进度表 + 链接 + 作业卡片） | ✅ |
| `/course/gradebook.php?cid=115` | 成绩册 | ✅ |
| `/course/listusers.php?cid=115` | 成员列表（敏感） | ✅ |
| `/assessment/showtest.php?cid=115&id=1025` | 作业/测验页 | ✅ |
| `/report/upload.php?cid=115` | 实验报告上传 | ✅ |
| `/courseware/uploadlist.php?cid=115` | 课件列表 | ✅ |
| `/msgs/msglist.php` | 站内消息 | ✅ |
| `/diag/index.php`、`/forms.php?action=newuser` | 诊断/注册 | 公开 |
| `/course/gb.php`、`assessment/process.php`、`startassess.php` | — | 404 |

## 4. 页面结构

### 4.1 课程页

两类信息：

1. 进度表（`<table>`）：
   - 表头：`9月14日-9月27日` 等教学周窗口；
   - 「作业1..6」行：每列一个作业，截止取窗口最后一天；
   - 「9月27日…」行 + 「Lab1..8」行：实验报告截止日期。
2. 作业卡片：

```html
<div class=item>
  <div class=title><b><a href="../assessment/showtest.php?id=1025&cid=115">Exercise 4 (Chap 4)</a></b>
    <BR> Due Sun 11/8/26, 7:59 am </div>
  <div class=itemsum>第4次作业(Ch-4)</div>
</div>
```

`Due` 是美式格式，按 Asia/Shanghai 解析。年份只在卡片里，进度表只有月日，CLI 用卡片的年份补全。

### 4.2 测验页

```html
<form id="testform" method=post action="showtest.php?action=shownext&score=0">
  <div class=question>
    <div>题干</div>
    <div class="toppad">
      <label for="qn0"><b>A: </b></label><input name=qn0>          <!-- 填空 -->
      <!-- 或 -->
      <ul class=nomark><li><input type=radio name=qn3 value=0>选项</li>…</ul>
    </div>
  </div>
  <div class="review">Points possible: 10<br/>Unlimited attempts.
    <input type=hidden name="verattempts" value="0" /></div>
</form>
```

关键约束：

- **一页一题**，`showall/print/review` 等参数无效；
- 字段名逐题变化：`qn0`、`qn1`、`qn2`…；单选是 `value=0/1/2`；
- **`verattempts` 必须原样回传**，否则同题反复重刷；
- POST 响应就是下一题（不要重新 GET，会回到第一题）；
- 题目随机：同一作业两次尝试参数会变（如 1000 Mbps → 100 Mbps）。

重置：`GET showtest.php?reattempt=all`（**不能带 cid/id**），会清空所有得分。

### 4.3 实验报告上传

```html
<form enctype="multipart/form-data" method=post action="upload.php?cid=115">
  <select name="reportID"><option value='1'>Lab 1</option>…</select>
  <input type="hidden" name="MAX_FILE_SIZE" value="20000000" />
  <input name="userfile" type="file" />
</form>
```

- 上限 20 MB；
- 已上传列表在页面表格里（`Report ID / Upload Date / FileName / FileSize`），`<td>` 没有闭合标签，解析要容错；
- 上传后 CLI 会用列表核对。

### 4.4 成绩册

首行是表头（`Item / Possible / Grade / Percent / Feedback`），后续行转对象即可。

## 5. 解析注意

- 整站 GB2312：按 `content-type` 的 charset 解码（Node `TextDecoder('gb2312')`）；
- `href` 里的 `&amp;` 要先反转义，否则取不到 `id`；
- 多个表格的 `<td>` 省略闭合标签，单元格解析以「下一个 `<td>/<tr>` 开头」为界；
- 进度表表头是中文日期（`9月14日-9月27日`），不是数字日期。

## 6. CLI 对应实现

| 命令 | 实现 |
| --- | --- |
| `login` | `src/login.js`（md5 方案 + timestamp） |
| `ddl` | 卡片 `Due` + 进度表（作业/实验）+ `/report/upload.php` 已交列表 |
| `items` | 课程页链接 + 进度表原始行 |
| `show` | 解析题干、满分、`answer_input`、选项、`verattempts` |
| `answer` | 逐页 POST，回传 `qnN` + `verattempts`，最后解析分数 |
| `upload` | multipart POST（`reportID` + `userfile`），默认 dry-run |
| `gradebook` | 表头→对象 |
