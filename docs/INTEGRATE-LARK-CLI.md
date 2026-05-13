# 集成 Lark CLI 方案

> Revision history
> - v1 (`00237f8`): initial draft
> - v2: address review comments from PR #77 — 取消 `xc-skills` 全局安装,改 `npx @latest`;`lark-cli` 安装失败改为中止安装;`appId/appSecret` 由 `zylos-lark` 注入 `lark-cli`,user 认证延迟到首次调用时再做;补充升级路径与 skill 自动发现的说明。
> - v3: 补齐 `lark-cli` 二进制(`@larksuite/cli`)的安装步骤;`add`/`upgrade` 流程均改为「先探测,缺失才装」;升级路径补齐对老版 `zylos-lark`(只有 `.env`、没有 lark-cli)的迁移;凭据写入通过 `saveLarkCliConfig`(与 Go 版 lark-cli 同字段、同算法,直接落 keychain)。
> - **v4 (this revision)**: 把 `config-init-store.js` 从 `zylos-core` 挪进 `zylos-lark/src/lib/`。zylos-core 自己没人 import 这个文件(`feat/update-lark` 上的 `add.js` 集成是探索版本,已废弃),留在那里只会给 zylos-lark 的 hook 制造一个跨仓库 import 解析的麻烦。挪到本仓库后,hook 走相对路径 import,版本演进独立,测试无需 mock 路径。

## 1. 背景

- `zylos-core` 是 AI agent 主项目,`cli/commands/add.js` 负责 `zylos add <skill>` 的拉取与安装。
- `zylos-lark` 是其生态下的一个 skill,承担 Lark 通讯通道职责,默认安装到 `~/zylos/.claude/skills/lark/`。
- `lark-cli` 指 Larksuite 官方 CLI(<https://github.com/larksuite/cli>),由**两部分**组成,独立分发、**都必须装**:
  - **二进制**:Go 编译产物,通过 `@larksuite/cli` npm 包分发(`/usr/local/bin/lark-cli`、或 `npm bin -g` 路径下)。
  - **Agent Skill 包**:20+ 个独立子 skill(`lark-im` / `lark-doc` / `lark-base` / `lark-calendar` …),通过 `xc-skills` 包从 GitHub 拉取并**平铺**到目标目录。

标准安装顺序:

```bash
# 1. 安装 lark-cli 二进制(必装;否则后续 `lark-cli ...` 任何调用都会 ENOENT)
npm install -g @larksuite/cli

# 2. 安装 20+ Agent Skill 到指定目录(改用 npx,绕开对 xc-skills 的全局写权限要求)
npx xc-skills@latest add https://github.com/larksuite/cli --out <target-dir> -y
```

> v1/v2 文档遗漏了步骤 1,以为只跑 `npx xc-skills add` 就够。实测 `xc-skills` 只搬 SKILL.md 文件,**不会**带二进制。本方案两步都纳入 `post-install` / `post-upgrade` 钩子,各自先探测、缺失才装(幂等)。

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
| 2 | `zylos-lark` | `hooks/post-install.js` | **(a)** 探测 `lark-cli` 二进制是否在 PATH 上;缺失则 `npm install -g @larksuite/cli`。**(b)** 探测 `${SKILL_DIR}/references/lark-im/SKILL.md` 是否存在(子 skill 已铺探针);缺失则 `npx xc-skills@latest add https://github.com/larksuite/cli --out ${SKILL_DIR}/references -y` 平铺装 20+ Agent Skill。两步任一失败即中止。 |
| 3 | `zylos-lark` | `hooks/post-install.js` + `src/lib/config-init-store.js`(新) | 把 `~/zylos/.env` 的 `LARK_APP_ID` / `LARK_APP_SECRET` 同步给 `lark-cli`(写 `~/.lark-cli/config.json` + 加密 secret 落 keychain)。`config-init-store.js` 字节复制自 `zylos-core feat/update-lark @ e9b63d1` (gavin 的原版),挪到 zylos-lark 后做相对路径 import,字段名、AES-256-GCM 算法、文件布局与 Go 版 lark-cli 完全互操作(见 §4.4)。 |
| 4 | `zylos-lark` | `hooks/post-upgrade.js` | 老版 `zylos-lark`(无 lark-cli)升级时,**幂等地**跑同样的 (a)/(b)/凭据同步三步,把缺失的部分补齐(见 §4.6)。 |
| 5 | `zylos-lark` | `SKILL.md` | 增加 `Bundled Sub-skills` 章节,描述 `references/` 下 20+ 子 skill 的存在 + 职责分工。 |
| 6 | `zylos-lark` | `src/lib/lark-cli-bridge.js`(新文件) | 包一层 `runLarkCli()`,识别 user-auth 缺失时通过 C4 引导 owner 完成 `auth login`(见 §4.5)。 |

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
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// keychain 写入逻辑(与 Go 版 lark-cli 互操作)。
// 该模块封装了:写 ~/.lark-cli/config.json(appSecret 字段存 {source:"keychain", id:"appsecret:<appId>"})、
// AES-256-GCM 加密 appSecret 到 ~/.local/share/lark-cli/appsecret_<appId>.enc(Linux)、
// 主密钥落同目录 master.key,macOS 走 system Keychain / Windows 走 DPAPI+registry。
import { saveLarkCliConfig } from '../src/lib/config-init-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');
const bundlesDir = path.join(skillRoot, 'references');

mkdirSync(bundlesDir, { recursive: true });

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function installLarkCliBinary() {
  // 探针:PATH 上是否能找到 lark-cli。任何 PATH 下的位置都算"已装",不强求全局 npm。
  if (commandExists('lark-cli')) {
    console.log('[zylos-lark] lark-cli binary already on PATH, skipping');
    return;
  }
  console.log('[zylos-lark] lark-cli binary missing; installing @larksuite/cli globally');
  execSync('npm install -g @larksuite/cli', { stdio: 'inherit' });
  if (!commandExists('lark-cli')) {
    throw new Error('lark-cli still not found in PATH after `npm install -g @larksuite/cli`');
  }
}

function installLarkCliSkills() {
  // 探针:任选一个固定存在的子 skill 的 SKILL.md(lark-im 是 lark-cli 的核心、不会被裁掉)。
  const probe = path.join(bundlesDir, 'lark-im', 'SKILL.md');
  if (existsSync(probe)) {
    console.log('[zylos-lark] lark-cli sub-skills already present, skipping');
    return;
  }
  console.log('[zylos-lark] installing lark-cli sub-skills into', bundlesDir);
  execSync(
    `npx xc-skills@latest add https://github.com/larksuite/cli --out "${bundlesDir}" -y`,
    { stdio: 'inherit' }
  );
}

function syncCredentialsToLarkCli() {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('LARK_APP_ID / LARK_APP_SECRET missing in env');
  }
  // saveLarkCliConfig 内部完成:
  //   1) 把 appSecret 明文 AES-256-GCM 加密,写到 ~/.local/share/lark-cli/appsecret_<appId>.enc
  //   2) master.key(同目录,0600)缺失则创建
  //   3) 写 ~/.lark-cli/config.json,appSecret 字段使用 {source:"keychain", id:"appsecret:<appId>"} 引用
  //   4) 与 Go 版 lark-cli 的 keychain 字段名、加密参数、文件布局完全一致 —— lark-cli 下次启动可直接读
  const result = saveLarkCliConfig({
    appId,
    appSecret,
    brand: 'lark',  // 本组件即为 lark,固定写死
    lang: 'zh',
  });
  console.log('[zylos-lark] synced App credentials to lark-cli:', {
    configPath: result.configPath,
    keychainID: result.keychainID,
  });
}

// 三步均失败即中止,与 §4.4 "中止 + 回滚" 一致
installLarkCliBinary();
installLarkCliSkills();
syncCredentialsToLarkCli();

console.log(
  '[zylos-lark] next step: run `lark-cli auth login --recommend` once for user-level OAuth ' +
  '(or wait for the agent to prompt on first user-scope call).'
);
```

要点:

- **三步均幂等 + 先探测后安装**:
  - `lark-cli` 二进制:`command -v` 探测,缺失才 `npm install -g @larksuite/cli`。
  - 子 skill 包:`references/lark-im/SKILL.md` 探针,缺失才 `npx xc-skills add`。
  - 凭据同步:每次都调 `saveLarkCliConfig`(`atomicWrite` + 写 keychain),覆盖式更新,Owner 在 `zylos add lark` 时输入的最新值始终落地。
- **非全局 xc-skills**:`npx xc-skills@latest`,绕开对 npm 全局目录的写权限要求(`@larksuite/cli` 本身必须 `-g`,但只在 lark-cli 首次安装时执行一次,可接受)。
- **失败中止**:不再 `try/catch + warn`,任一环节非零退出 → `add.js` 回滚 zylos-lark 主体安装。
- **凭据复用 = 直接落 lark-cli keychain**:不写 YAML / dotfile,直接调 `saveLarkCliConfig`,与 Go 版 lark-cli 的 `~/.lark-cli/config.json` schema + AES-256-GCM keychain 完全互操作。User 不需要在 lark-cli 里再 `config init` 一次。
- **末尾提示**:User 级 OAuth 是延迟触发的,但仍打印一条提示告知 owner 「有需要时再 `auth login`」,避免用户误以为漏装了什么。

### 4.2.1 `saveLarkCliConfig` 来源

**`config-init-store.js` 字节复制自 `zylos-core feat/update-lark @ e9b63d1`(gavin 的原版),完整搬到 `zylos-lark/src/lib/config-init-store.js`,不再走跨仓库 import**。

为什么不留在 zylos-core:

| 维度 | 留在 zylos-core | 挪进 zylos-lark(本方案) |
|---|---|---|
| 唯一消费者 | zylos-lark | zylos-lark ✓ |
| 内容性质 | `SERVICE = "lark-cli"` 硬编码,全是 lark-cli keychain 互操作逻辑 | 与 zylos-lark "我就是 lark 组件" 职责对齐 |
| import 复杂度 | 运行时 `which zylos → realpath → 拼 lib/ → 动态 import(file://...)` | `import from '../src/lib/config-init-store.js'` 一行 |
| 跨仓库依赖 | 需要 `npm link` 或 `ZYLOS_CORE_LIB` 环境变量解析 | 零依赖 |
| 版本耦合 | lark-cli 改 keychain 格式 → zylos-core 和 zylos-lark 必须协调发版 | 只 zylos-lark 改一处 |
| 测试 | 单测必须 mock import 路径 | 普通相对 import,直接测 |

未来如果出现第二个 lark-cli-using zylos 组件需要复用,届时再考虑抽包,YAGNI。

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
| `npm install -g @larksuite/cli` 失败(npm 网络 / 全局写权限) | 中止 + 回滚 | 安装失败,提示检查 npm 全局目录权限或网络,可手动跑后重试 |
| `npx xc-skills add` 失败(网络 / 包不可达) | 中止 + 回滚 | 安装失败,提示重试 |
| `saveLarkCliConfig` 失败(`.env` 缺字段 / keychain 写入失败 / `config.json` 原子写失败) | 中止 + 回滚 | 安装失败,提示先在 `zylos add lark` 阶段把 `appId/appSecret` 配齐 |
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
| `zylos upgrade lark`(主体升级) | 升级 zylos-lark 主体 + `post-upgrade` 钩子跑「**老版迁移**」三步(见 §4.6.1):补装 lark-cli 二进制、补装子 skill、把 `.env` 凭据同步进 lark-cli keychain。**默认不重新拉**已存在的 `references/`(保留稳定版,避免连锁副作用);`pre-upgrade` 钩子保留整个 `references/` 目录,避免 20+ 子 skill 被擦掉 |
| `zylos upgrade lark --with-bundles`(可选,本次不实现) | 升级 zylos-lark 主体 + 重新跑 `xc-skills add ... --force` 升级 `references/` 下所有 lark-cli 子 skill |
| `npm run bundle:upgrade`(顶层脚本,本次实现) | 用户手动重新拉 lark-cli 最新版,只动 `references/`,不动 zylos-lark 主体 |
| `zylos remove lark` | 一并删除 `references/` 目录;**不**清 lark-cli keychain(`~/.lark-cli/` 与 `~/.local/share/lark-cli/` 保持原样,Owner 可能仍在用其它 agent / 手工调 lark-cli);**不**卸载全局 `@larksuite/cli` 二进制(可能被其它 skill 共用)。如需彻底清理,Owner 自行跑 `lark-cli config remove`。 |

理由:zylos-lark 与 lark-cli 是两个独立 release cycle 的项目,默认解耦升级避免连锁副作用;真要联动升级,显式 `--with-bundles` 选 in。

### 4.6.1 老版 zylos-lark 升级时的迁移(`post-upgrade.js`)

适用场景:**v0.2.x 及更早的 `zylos-lark` 安装**完全不知道 `lark-cli` 的存在 —— 那时只有 `.env` 的 `LARK_APP_ID/SECRET`,二进制和子 skill 都没装,凭据也没进 keychain。`zylos upgrade lark` 跑到新版后,必须**幂等地**把这三件事都补齐。

实现上,`post-upgrade.js` 直接复用 `post-install.js` 的三个函数(从同一个内部模块 import,不复制粘贴):

```js
// hooks/post-upgrade.js
import { installLarkCliBinary, installLarkCliSkills, syncCredentialsToLarkCli }
  from './post-install-shared.js';  // §4.2 的三个函数抽到这里复用

console.log('[zylos-lark] post-upgrade: ensuring lark-cli is present and credentials are synced');

installLarkCliBinary();    // 老版没装 → 走 npm install -g @larksuite/cli;新版已装 → 立即返回
installLarkCliSkills();    // 老版没装 → 走 xc-skills add;新版已装 → 立即返回
syncCredentialsToLarkCli();// .env 凭据每次都重新同步 keychain(覆盖式),应对 secret 轮换

console.log('[zylos-lark] post-upgrade migration done');
```

为什么 `syncCredentialsToLarkCli` 不做"已存在则跳过":

- `.env` 是 owner 凭据的**单一来源**,owner 在 Lark 后台 Reset App Secret 后只需改 `.env`;`post-upgrade` 跑一次 `saveLarkCliConfig` 即可把新 secret 推进 keychain,无需手动 `lark-cli config init`。
- `saveLarkCliConfig` 内部用 `atomicWrite` + `keychainSet` 覆盖式写,幂等且并发安全。

边界情况:

| 情况 | 行为 |
|---|---|
| 老版升新版,`.env` 没设 `LARK_APP_ID/SECRET` | 中止升级,提示 owner 先把 `.env` 配齐再 `zylos upgrade lark`(与 §4.4 一致) |
| 老版升新版,`lark-cli` 已被其它 skill 装过 | `commandExists('lark-cli')` 命中,跳过二进制安装 |
| 新版升更新版(已经历过迁移) | 三个探针都命中,三步全跳;仅 `syncCredentialsToLarkCli` 覆盖式重写(开销可忽略) |
| 多次升级中途失败 | 三步独立幂等,重跑 `zylos upgrade lark` 即可继续 |

## 5. 已验证决策

- **`lark-cli` 二进制必须 `npm install -g @larksuite/cli`**:实测安装路径 `<npm-prefix>/lib/node_modules/@larksuite/cli/bin/lark-cli`,本体是静态链接 Go 二进制。`xc-skills add` 只搬 SKILL.md 文件,不会带二进制。
- 通过在 `add.js` 中硬编码,可以正常把 `lark-cli` 安装到 `zylos-lark` 子目录:
  ```bash
  npx xc-skills@latest add https://github.com/larksuite/cli --out {目录} -y
  ```
- `lark-cli` 自带的 20+ Agent Skill 由 xc-skills **平铺**装到 `references/`(不嵌套在 `references/lark-cli/` 子目录里),每个 `references/lark-*/` 都是一个独立的 skill,**agent 会自动发现并加载它们**(因为各自带 SKILL.md)。
  → 这意味着 §4.3 的 `Bundled Sub-skills` 章节不是为"被发现"而存在,而是为「告诉 agent 在 zylos-lark 自身能力与 `references/` 下子 skill 之间该选谁」存在。
- **`lark-cli` 的 keychain 已验证可互操作**:用 `src/lib/config-init-store.js` 的 `saveLarkCliConfig` 写入凭据后,lark-cli 进程能正确读取并完成端到端调用(实测 `lark-cli api GET /open-apis/bot/v3/info --as bot` 返回 `code:0` + bot 真身信息)。strace 确认进程依序读取 `~/.lark-cli/config.json` → `appsecret_<appId>.enc` → `master.key`,然后向 `/open-apis/auth/v3/tenant_access_token/internal` 换 token。
- **App 认证无需浏览器跳转**:有了 `appId + appSecret` 直接 POST `tenant_access_token/internal` 即可换出 `tenant_access_token`(`expire ~ 7200s`);浏览器跳转仅用于 user-scope 的 `auth login`,不适用于 App 身份。
- `lark-cli` 的 User 认证必须通过 `auth login --recommend`(扫码 / 浏览器),无法在安装阶段自动完成。

## 6. 待验证

- `add.js` 当前是否已经调用 `post-install` 钩子?(决定 §4.1 的实际工作量)
- ~~`lark-cli` config 文件的真实路径与 schema~~ **(v3 已解决)**:实测路径 `~/.lark-cli/config.json`(JSON 而非 YAML);`appSecret` 字段不是明文,而是 `{source:"keychain", id:"appsecret:<appId>"}` 引用;明文经 AES-256-GCM 加密落 `~/.local/share/lark-cli/appsecret_<appId>.enc`,主密钥 `master.key` 同目录、0600。`saveLarkCliConfig` 已封装,直接复用即可。
- ~~`saveLarkCliConfig` 的依赖路径~~ **(v4 已解决)**:`config-init-store.js` 直接挪进 `zylos-lark/src/lib/`,hook 走相对路径 import,不再需要跨仓库解析。
- **`lark-cli` "未认证"错误的具体字串 / exit code**:`runLarkCli()` 的兜底匹配需要枚举确认,避免漏判 / 误判。实测 calendar/mail 等域返回 `calendar_user_login_required` 类型 + exit code 3,可作为匹配锚点;其它域待补全。
- **`lark-cli auth login` 是否支持 device code flow**:决定能否把扫码 URL 直接推到 IM。
- **多 runtime 影响**:Claude Code / Codex 都会读 `SKILL.md`,理论上无差异;需要在 Codex 上跑一次确认。
- **凭据轮换联动**:owner 在 Lark 后台 Reset App Secret 后改 `.env`,需要触发一次 `saveLarkCliConfig` 才能让 lark-cli 也用新值。已规划两条触发点:(a) `zylos upgrade lark` 的 `post-upgrade` 钩子无条件重同步(§4.6.1);(b) zylos-lark 自带的 `admin set-app-credentials` 命令(本次先打 TODO)。

## 7. 测试方案

### 单测

`hooks/post-install.js` / `hooks/post-upgrade.js`(共用 `post-install-shared.js`):

- `installLarkCliBinary`:mock `commandExists` 命中 → 跳过 npm;mock 不命中 + `npm install -g` 成功 / 失败两种状态。
- `installLarkCliSkills`:mock 探针文件存在 / 不存在;`npx xc-skills add` 成功 / 失败。
- `syncCredentialsToLarkCli`:
  - mock `.env` 缺 `LARK_APP_ID` → 抛错 → hook 非零退出。
  - mock `saveLarkCliConfig` 抛 keychain 写入异常 → 同样非零退出。
  - 正常路径:断言 `~/.lark-cli/config.json` 里 `appSecret.id === "appsecret:<appId>"`、`~/.local/share/lark-cli/appsecret_<appId>.enc` 长度 = 12+ciphertext+16。

### 集成测试

- **干净环境 `zylos add lark`**,断言:
  - `lark-cli` 在 PATH 上(`which lark-cli` 成功)
  - `references/` 下 lark-cli 的 20+ 子 skill 全部存在(至少抽样断言 `lark-im/SKILL.md`、`lark-calendar/SKILL.md`、`lark-mail/SKILL.md` 存在)
  - `~/.lark-cli/config.json` 中 `apps[0].appId` 等于 `.env` 里的 `LARK_APP_ID`
  - `~/.local/share/lark-cli/appsecret_<appId>.enc` 存在且非空,`master.key` 存在且为 32 字节
  - 用 `saveLarkCliConfig` 导出的 `decryptData` 解出来的明文 == `.env` 里的 `LARK_APP_SECRET`(端到端回环)
  - 终端打印了 user OAuth 提示
- **再次 `zylos add lark`** → 断言所有三步走"已存在则跳过"或"覆盖式重写",整体退出码 0。
- **模拟离线** → 断言**主体安装失败**(不是 warn 继续)。
- **不跑 `auth login`**,让 agent 触发 lark-cli user-scope 命令 → 断言 `runLarkCli` 识别并通过 C4 把引导 DM 推给 owner。
- **老版升级**(关键新增):在 v0.2.x 环境(只有 `.env`、无 lark-cli)上跑 `zylos upgrade lark`,断言 `post-upgrade` 完成后:
  - `lark-cli` 二进制就绪
  - `references/` 下子 skill 就绪
  - keychain 已写入,明文回环验证通过
  - `lark-cli api GET /open-apis/bot/v3/info --as bot` 返回 `code:0`(端到端 token 交换打通)
- **凭据轮换**:改 `.env` 的 `LARK_APP_SECRET` → 跑 `zylos upgrade lark` → 断言新值已落 keychain,旧值不可再用换 token。

### 手动 checklist

- Claude 读 `SKILL.md` 后能说出「IM 用 zylos-lark / 用户数据用 lark-cli」的职责分工。
- `npm run cli test` 通过。
- PM2 `zylos-lark` 重启正常。
- E2E:跑完 `auth login` → `lark-cli mail +triage --as user` 成功返回数据。
- 升级路径:`zylos upgrade lark` → `references/` 下所有 `lark-*` 子 skill **不**被擦掉。
- 老版升级:从 v0.2.x 升到当前版本,`lark-cli api GET /open-apis/bot/v3/info --as bot` 直接可用,无需手动 `lark-cli config init`。

## 8. 原 §8 问题的回应

> Q1. lark-cli 装到子目录后 agent 会自动识别成独立 skill,还需要在 SKILL.md 里声明吗?

需要,但**目的变了**。不是为"被发现",而是为「让 agent 知道职责分工」—— 同一件事 zylos-lark 和 lark-cli 都能做时,SKILL.md 里那张职责分工表是唯一的权威指导。

> Q2. lark-cli 的 App 认证是否可以复用 zylos-lark 的?

**可以,而且本方案把它列为强约束**。`post-install` / `post-upgrade` 调用 `syncCredentialsToLarkCli`(§4.2),底层直接复用 `zylos-core/cli/lib/config-init-store.js` 的 `saveLarkCliConfig`,把 `.env` 的 `appId/appSecret` 写进 `~/.lark-cli/config.json` + `~/.local/share/lark-cli/appsecret_<appId>.enc`(AES-256-GCM,master.key 同目录)。Owner 不需要再跑 `lark-cli config init`,后续浏览器跳转那一步也不需要(App 身份的 `tenant_access_token` 用 `appId + 解密后的 appSecret` 直接换,见 §5 已验证决策)。

> Q3. User 认证应该装完就让用户认证,还是用到时再认证?

**用到时再认证**(reviewer 也是这个意见)。安装阶段只在终端打一句提示,不阻塞 `zylos add lark` 流程;runtime 首次触发 user-scope 命令时,由 `runLarkCli` 捕获错误 → C4 给 owner 发 DM 引导。这样既不打扰只用 IM 通道的用户,也不会让真用 user-scope 功能的人陷在"不知道还要登录"的盲区。
