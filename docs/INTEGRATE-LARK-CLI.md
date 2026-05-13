# 集成 Lark CLI 方案

> Revision history
> - v1 (`00237f8`): initial draft
> - **v2 (this revision)**: address review comments from PR #77 — 取消 `xc-skills` 全局安装,改 `npx @latest`;`lark-cli` 安装失败改为中止安装;`appId/appSecret` 由 `zylos-lark` 注入 `lark-cli`,user 认证延迟到首次调用时再做;补充升级路径与 skill 自动发现的说明。

## 1. 背景

- `zylos-core` 是 AI agent 主项目,`cli/commands/add.js` 负责 `zylos add <skill>` 的拉取与安装。
- `zylos-lark` 是其生态下的一个 skill,承担 Lark 通讯通道职责,默认安装到 `~/zylos/.claude/skills/lark/`。
- `lark-cli` 指 Larksuite 官方 CLI(<https://github.com/larksuite/cli>),本身是 `xc-skills` 生态下的 skill。

`lark-cli` 标准安装方式(改用非全局):

```bash
# 不再执行 `npm install -g xc-skills` — 直接用 npx 拉最新版,避免对 npm 全局目录的写权限要求
npx xc-skills@latest add https://github.com/larksuite/cli --out <target-dir> -y
```

## 2. 目标

1. `zylos add lark` 自动把 `lark-cli` 一起装上。
2. `lark-cli` 自带的 **20+ 个 Agent Skill** 固定安装到 `<lark-skill-root>/references/`,例如 `~/zylos/.claude/skills/lark/references/`(详见 §3.1 目录结构)。
3. `zylos-lark` 根目录 `SKILL.md` 增加章节,说明 `zylos-lark` 自身能力 + `references/` 子目录里的额外能力。
4. **App 级认证一次到位**:`zylos add lark` 收集的 `appId`/`appSecret` 自动注入 `lark-cli` 的 config,用户不重复填写。
5. **User 级认证延迟触发**:不在安装阶段强求,首次调用 user-scope 命令时由 agent 通过 IM 引导 owner 完成 `auth login`。

## 3. 方案概述

把 `lark-cli` 安装作为 `zylos-lark` 的 `post-install` 步骤,由 `zylos-core` 标准 `add` 流程触发;
在 `zylos-lark` 的 `SKILL.md` 显式记录子能力与职责分工。

### 3.1 安装后的目录结构

`zylos add lark` 跑完后,`~/zylos/.claude/skills/lark/` 长这样:

```
~/zylos/.claude/skills/lark/
├── SKILL.md                  # zylos-lark 自身的 skill 描述(本次新增章节)
├── package.json
├── src/                      # zylos-lark 源代码
├── scripts/                  # send.js / download.js
├── hooks/                    # post-install / pre-upgrade / post-upgrade
└── references/               # ⬅ 本次新增:lark-cli 的 20+ 个 Agent Skill 直接铺在这里
    ├── lark-im/                  # IM 消息收发
    ├── lark-calendar/            # 日历
    ├── lark-doc/                 # Docs
    ├── lark-sheets/              # 电子表格
    ├── lark-base/                # 多维表格 Base
    ├── lark-mail/                # 邮件
    ├── lark-tasks/               # 任务
    ├── lark-approval/            # 审批
    ├── lark-drive/               # Drive
    ├── lark-wiki/                # Wiki / 知识库
    ├── lark-okr/                 # OKR
    ├── lark-contact/             # 通讯录
    ├── lark-attendance/          # 考勤
    ├── lark-meetings/            # 视频会议
    ├── lark-event/               # WebSocket 事件订阅
    ├── lark-skill-maker/         # 自定义 skill 脚手架
    ...                           # 共约 20+ 个,具体清单以 lark-cli 当版 release 为准
```

要点:
- **路径是 `references/`,不是 `skills/`** —— 这是 Claude Code skill 体系下「父 skill 内嵌子 skill」的官方约定目录名。
- **`references/` 下的每个子目录都是一个独立、可被 agent 直接调用的 skill**(各自带 `SKILL.md`)。
- **没有 `references/lark-cli/` 这一层** —— xc-skills 把 lark-cli 包内的 24 个 Agent Skill 直接平铺到 `--out` 指定的目录,没有额外包一层。
- 上层 agent(Claude / Codex)读到 `zylos-lark/SKILL.md` 后,**仍然能自动发现 `references/` 下的子 skill**(框架本来就支持这种嵌套发现);本方案在 SKILL.md 里再写一遍,是为了给 agent 提供「同一件事到底用哪个」的职责分工指引。

| 序号 | 项目 | 文件 | 改动 |
| --- | --- | --- | --- |
| 1 | `zylos-core` | `cli/commands/add.js` | 确保 `add` 流程会调用被安装 skill 的 `post-install` 钩子。 |
| 2 | `zylos-lark` | `hooks/post-install.js` | 调 `npx xc-skills@latest add larksuite/cli --out ${SKILL_DIR}/references -y`,把 lark-cli 的 20+ Agent Skill 平铺装到 `references/`;失败即中止。 |
| 3 | `zylos-lark` | `hooks/post-install.js` | 把 `~/zylos/.env` 的 `LARK_APP_ID` / `LARK_APP_SECRET` 注入 `lark-cli` 的 config(App 身份复用,见 §4.4)。 |
| 4 | `zylos-lark` | `SKILL.md` | 增加 `Bundled Sub-skills` 章节,描述 `references/` 下 20+ 子 skill 的存在 + 职责分工。 |
| 5 | `zylos-lark` | `src/lib/lark-cli-bridge.js`(新文件) | 包一层 `runLarkCli()`,识别 user-auth 缺失时通过 C4 引导 owner 完成 `auth login`(见 §4.5)。 |

## 4. 详细设计

### 4.1 改动:`zylos-core/cli/commands/add.js`

现状:`add.js` 在解包 skill 后会读取 `SKILL.md` 的 `lifecycle` 字段并执行 hooks。

`zylos-lark` 已声明:

```yaml
lifecycle:
  hooks:
    post-install: hooks/post-install.js
```

→ 待验证:确认 `add.js` 当前实现真的会调用 `post-install`(若已支持,本节为零改动)。

### 4.2 改动:`zylos-lark/hooks/post-install.js`

```js
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');
// lark-cli 的 20+ Agent Skill 平铺装在这个目录下,不再包一层 lark-cli/
const bundlesDir = path.join(skillRoot, 'references');

mkdirSync(bundlesDir, { recursive: true });

function installLarkCli() {
  // 用 lark-cli 子 skill 中固定存在的一个(lark-im)作为「装过没」的探针
  const probe = path.join(bundlesDir, 'lark-im');

  if (existsSync(probe)) {
    console.log('[zylos-lark] lark-cli sub-skills already present, skipping');
    return;
  }

  console.log('[zylos-lark] installing lark-cli sub-skills into', bundlesDir);
  // 不再 `npm install -g xc-skills`;直接 npx 拉最新版,避免全局写权限问题
  execSync(
    `npx xc-skills@latest add https://github.com/larksuite/cli --out "${bundlesDir}" -y`,
    { stdio: 'inherit' }
  );
}

function injectAppCredentials() {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('LARK_APP_ID / LARK_APP_SECRET missing in env');
  }
  // ⚠ 真实路径与 schema 待验证,以 lark-cli 自身文档为准;以下为占位
  const cfgDir = path.join(os.homedir(), '.lark-cli');
  mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, 'config.yaml');
  writeFileSync(
    cfgPath,
    `profiles:\n  default:\n    app_id: ${appId}\n    app_secret: ${appSecret}\n`,
    { mode: 0o600 }
  );
  console.log('[zylos-lark] injected App credentials into', cfgPath);
}

// 失败即中止 — 不再 try/catch warn,与 §4.4 错误回滚策略保持一致
installLarkCli();
injectAppCredentials();
console.log('[zylos-lark] next step: run `lark-cli auth login --recommend` once to complete user-level OAuth (or wait for agent to prompt you on first user-scope call)');
```

要点:

- **幂等**:子目录已存在则跳过。
- **非全局安装**:`npx xc-skills@latest`,绕开 `npm install -g` 的权限问题;每次冷启动会从 npm 取一次,可接受。
- **失败中止**:不再 `try/catch + warn`,与 §4.4 "中止 + 回滚" 一致。`add.js` 收到非零退出码后应回滚 zylos-lark 主体安装。
- **App 凭据注入**:把 `.env` 的 `LARK_APP_ID` / `LARK_APP_SECRET` 写入 `lark-cli` 的 config,owner 不需要在 `lark-cli` 里再填一次。`mode: 0o600` 限制仅 owner 可读。
- **末尾提示**:User 级 OAuth 是延迟触发的,但仍打印一条提示告知 owner 「有需要时再 `auth login`」,避免用户误以为漏装了什么。

### 4.3 改动:`zylos-lark/SKILL.md` 增加 `Bundled Sub-skills` 章节

```md
## Bundled Sub-skills

`zylos-lark` 安装时会自动把官方 `lark-cli` 的 20+ 个 Agent Skill 平铺到 `./references/` 子目录。

实际目录结构:

​```
<skill-root>/lark/
└── references/
    ├── lark-im/          ├── lark-calendar/    ├── lark-doc/
    ├── lark-sheets/      ├── lark-base/        ├── lark-mail/
    ├── lark-tasks/       ├── lark-approval/    ├── lark-drive/
    ├── lark-wiki/        ├── lark-okr/         ├── lark-contact/
    ├── lark-attendance/  ├── lark-meetings/    ├── lark-event/
    ├── lark-skill-maker/ ...                   # 共 20+ 个
​```

> 注:`references/` 下的每个子目录都是独立的 skill(各自带 `SKILL.md`),agent 会**自动发现并加载**它们。
> 本章节存在的目的**不是让 agent 发现** —— 而是告诉 agent「同一件事 `zylos-lark` 和 `references/lark-*/` 都能做时,该选哪个」(见职责分工表)。

### 来源与认证

- **来源**:<https://github.com/larksuite/cli>(20+ Agent Skill 由 lark-cli 包提供,通过 xc-skills 平铺安装)
- **认证**(所有 `references/lark-*/` 子 skill 共用):
  - **App 身份**:由 `zylos-lark` 在 `post-install` 时把 `.env` 的 `appId`/`appSecret` 注入 lark-cli config,无需重复填写。
  - **User 身份**:首次调用 user-scope API(我的邮件 / 日历 / OKR / Drive / 审批)时,agent 通过 IM 引导 owner 跑 `lark-cli auth login --recommend`(扫码),token 落 OS keychain。

### 与 zylos-lark 自身能力的职责分工

| 场景 | 优先使用 | 理由 |
| --- | --- | --- |
| 收发 IM、群管理、事件订阅 | **zylos-lark**(自身 `src/`) | 常驻 webhook 服务 + 事件回路,天然适配 App 身份 |
| 用户级数据(我的邮件 / 日历 / OKR / Drive / 审批) | **`references/lark-mail` 等**(lark-cli 子 skill) | 必须 user_access_token,只能走 lark-cli |
| App scope 内的一次性 Open API 调用 | `zylos-lark` 自身优先;未覆盖时回落到对应 `references/lark-*/` 子 skill | zylos-lark 已维护 token,避免重复登录 |
```

### 4.4 错误与回滚策略

| 失败点 | 行为 | 用户感知 |
| --- | --- | --- |
| `zylos-lark` 主体安装失败 | 中止 + 回滚 | 与改前一致 |
| `npx xc-skills add` 失败(网络 / 包不可达) | 中止 + 回滚 | 安装失败,提示重试 |
| App 凭据注入失败(`.env` 缺字段 / 写文件失败) | 中止 + 回滚 | 安装失败,提示先在 `zylos add lark` 阶段把 `appId/appSecret` 配齐 |
| runtime user-scope 未认证 | `runLarkCli` 捕获 → C4 发 DM 引导 `auth login` | owner 收 IM,扫码后告诉 agent 重试 |

→ 与 v1 的关键差异:**不再有 "warn 并继续"** 的分支。`lark-cli` 任何环节出错都拒绝完成本次 `zylos add lark`,与 review comment #2 一致。

### 4.5 改动:`src/lib/lark-cli-bridge.js`(新文件,runtime 兜底)

```js
import { execSync } from 'node:child_process';
import { sendOwnerDM } from './c4-helper.js'; // 已有 c4-send.js 的封装

const AUTH_FAIL_PATTERNS = [
  /not.?authent/i,
  /token.*expired/i,
  /auth.*required/i,
  /please.*login/i,
  // ⚠ 实际 lark-cli 错误字串待 §6 验证
];

export function runLarkCli(cmd, opts = {}) {
  try {
    return execSync(`lark-cli ${cmd}`, { encoding: 'utf8', ...opts });
  } catch (err) {
    const out = (err.stdout || '') + (err.stderr || '');
    if (AUTH_FAIL_PATTERNS.some(re => re.test(out))) {
      sendOwnerDM(
        '这条命令需要你的 lark-cli 用户级登录。请在终端执行:\n' +
        '  cd ~/zylos/.claude/skills/lark/references/lark-im   # 或任一 lark-* 子 skill 目录\n' +
        '  lark-cli auth login --recommend\n' +
        '扫码完成后回我"已登录",我会重试。'
      );
    }
    throw err;
  }
}
```

如 `lark-cli` 支持 device code flow(待验证),进一步可把扫码 URL 直接推到 IM,不必切终端。

### 4.6 升级路径

| 操作 | 行为 |
| --- | --- |
| `zylos upgrade lark`(主体升级) | **不联动**升级 `references/` 下的 lark-cli 子 skill;`pre-upgrade` 钩子保留整个 `references/` 目录,避免 20+ 子 skill 被擦掉 |
| `zylos upgrade lark --with-bundles`(可选,本次不实现) | 升级 zylos-lark 主体 + 重新跑 `xc-skills add ... --force` 升级 `references/` 下所有 lark-cli 子 skill |
| `npm run bundle:upgrade`(顶层脚本,本次实现) | 用户手动重新拉 lark-cli 最新版,只动 `references/`,不动 zylos-lark 主体 |
| `zylos remove lark` | 一并删除 `references/` 目录(lark-cli 子 skill 是它的子产物,不留孤立残留) |

理由:zylos-lark 与 lark-cli 是两个独立 release cycle 的项目,默认解耦升级避免连锁副作用;真要联动升级,显式 `--with-bundles` 选 in。

## 5. 已验证决策

- 通过在 `add.js` 中硬编码,可以正常把 `lark-cli` 安装到 `zylos-lark` 子目录:
  ```bash
  npx xc-skills@latest add https://github.com/larksuite/cli --out {目录} -y
  ```
- `lark-cli` 自带的 20+ Agent Skill 由 xc-skills **平铺**装到 `references/`(不嵌套在 `references/lark-cli/` 子目录里),每个 `references/lark-*/` 都是一个独立的 skill,**agent 会自动发现并加载它们**(因为各自带 SKILL.md)。
  → 这意味着 §4.3 的 `Bundled Sub-skills` 章节不是为"被发现"而存在,而是为「告诉 agent 在 zylos-lark 自身能力与 `references/` 下子 skill 之间该选谁」存在。
- `lark-cli` 的 App 认证支持通过预设 `appId/appSecret` + 浏览器跳转完成,`appSecret` 不会在用户界面明文出现。
- `lark-cli` 的 User 认证必须通过 `auth login --recommend`(扫码 / 浏览器),无法在安装阶段自动完成。

## 6. 待验证

- `add.js` 当前是否已经调用 `post-install` 钩子?(决定 §4.1 的实际工作量)
- **`lark-cli` config 文件的真实路径与 schema**(`~/.lark-cli/config.yaml`?其他?字段名是否为 `app_id` / `app_secret`?)→ §4.2 的注入代码必须按真实 schema 调整。
- **`lark-cli` "未认证"错误的具体字串 / exit code**:`runLarkCli()` 的兜底匹配需要枚举确认,避免漏判 / 误判。
- **`lark-cli auth login` 是否支持 device code flow**:决定能否把扫码 URL 直接推到 IM。
- **多 runtime 影响**:Claude Code / Codex 都会读 `SKILL.md`,理论上无差异;需要在 Codex 上跑一次确认。
- **凭据轮换联动**:zylos-lark 改 `.env` 后,`lark-cli` config 是否需要同步刷新?建议在 zylos-lark 的「set-app-credentials」管理命令里联动写一次(本次先打 TODO)。

## 7. 测试方案

### 单测

`hooks/post-install.js`:

- mock `npx xc-skills add` 成功 / 失败 / 子目录已存在三种状态。
- mock `.env` 缺 `LARK_APP_ID` → 注入步骤抛错 → post-install 整体非零退出。
- mock 注入文件写入失败 → 同样非零退出。

### 集成测试

- 干净环境执行 `zylos add lark`,断言:
  - `references/` 下 lark-cli 的 20+ 子 skill 全部存在(至少抽样断言 `lark-im/SKILL.md`、`lark-calendar/SKILL.md`、`lark-mail/SKILL.md` 存在)
  - `~/.lark-cli/config.yaml`(或真实路径)中写入了正确的 `app_id`
  - 终端打印了 user OAuth 提示
- 再次执行 → 断言 lark-cli 步骤跳过且整体成功。
- 模拟离线 → 断言**主体安装失败**(不是 warn 继续)。
- 不跑 `auth login`,让 agent 触发 lark-cli user-scope 命令 → 断言 `runLarkCli` 识别并通过 C4 把引导 DM 推给 owner。

### 手动 checklist

- Claude 读 `SKILL.md` 后能说出「IM 用 zylos-lark / 用户数据用 lark-cli」的职责分工。
- `npm run cli test` 通过。
- PM2 `zylos-lark` 重启正常。
- E2E:跑完 `auth login` → `lark-cli mail +list` 成功返回数据。
- 升级路径:`zylos upgrade lark` → `references/` 下所有 lark-* 子 skill **不**被擦掉。

## 8. 原 §8 问题的回应

> Q1. lark-cli 装到子目录后 agent 会自动识别成独立 skill,还需要在 SKILL.md 里声明吗?

需要,但**目的变了**。不是为"被发现",而是为「让 agent 知道职责分工」—— 同一件事 zylos-lark 和 lark-cli 都能做时,SKILL.md 里那张职责分工表是唯一的权威指导。

> Q2. lark-cli 的 App 认证是否可以复用 zylos-lark 的?

**可以,而且本方案把它列为强约束**。`post-install` 把 `.env` 的 `appId/appSecret` 注入 `lark-cli` 的 config(§4.2 `injectAppCredentials`),owner 不重复填。后续浏览器跳转那一步(若 lark-cli 在首次调用 App API 时还需要)由用户一次性确认即可。

> Q3. User 认证应该装完就让用户认证,还是用到时再认证?

**用到时再认证**(reviewer 也是这个意见)。安装阶段只在终端打一句提示,不阻塞 `zylos add lark` 流程;runtime 首次触发 user-scope 命令时,由 `runLarkCli` 捕获错误 → C4 给 owner 发 DM 引导。这样既不打扰只用 IM 通道的用户,也不会让真用 user-scope 功能的人陷在"不知道还要登录"的盲区。
