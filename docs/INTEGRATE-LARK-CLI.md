# 集成 Lark CLI 方案

## 1. 背景

- `zylos-core` 是 AI agent 主项目，`cli/commands/add.js` 负责 `zylos add <skill>` 的拉取与安装。
- `zylos-lark` 是其生态下的一个 skill，承担 Lark 通讯通道职责，默认安装到 `~/zylos/.claude/skills/lark/`。
- `lark-cli` 指 Larksuite 官方 CLI（<https://github.com/larksuite/cli>），本身是 `xc-skills` 生态下的 skill。

`lark-cli` 标准安装方式：

```bash
npm install -g @larksuite/cli
npm install -g xc-skills
npx xc-skills add https://github.com/larksuite/cli --out <target-dir> -y
```

## 2. 目标

1. `zylos add lark` 自动把 `lark-cli` 一起装上。
2. `lark-cli` 固定安装到 `<lark-skill-root>/skills/`，例如 `~/zylos/.claude/skills/lark/skills/lark-cli/`。
3. `zylos-lark` 根目录 `SKILL.md` 增加章节，说明 `zylos-lark` 自身能力和 `skills/` 子目录里的额外能力，让上层 agent 可识别。
4. 安装 `lark-cli` 后，需要交互式提示用户设置 user 级用户认证，或在用户使用具体功能时再做认证。

## 3. 方案概述

把 `lark-cli` 安装作为 `zylos-lark` 的 `post-install` 步骤，由 `zylos-core` 标准 `add` 流程触发；同时在 `zylos-lark` 的 `SKILL.md` 显式记录子能力。

| 序号 | 项目 | 文件 | 改动 |
| --- | --- | --- | --- |
| 1 | `zylos-core` | `cli/commands/add.js` | 确保 `add` 流程会调用被安装 skill 的 `post-install` 钩子。 |
| 2 | `zylos-lark` | `hooks/post-install.js` | 增加调用 `npx xc-skills add larksuite/cli --out ${SKILL_DIR}/skills -y`。 |
| 3 | `zylos-lark` | `SKILL.md` | 增加 `Bundled Sub-skills` 章节，列出 `skills/` 下的能力。 |
| 4 | `zylos-core` | `cli/commands/add.js` | 安装 `lark-cli` 结束后，同步进行用户认证：`lark-cli auth login --recommend`。 |

## 4. 详细设计

### 4.1 改动：`zylos-core/cli/commands/add.js`

现状：`add.js` 在解包 skill 后会读取 `SKILL.md` 的 `lifecycle` 字段并执行 hooks。

`zylos-lark` 已声明：

```yaml
lifecycle:
  hooks:
    post-install: hooks/post-install.js
```

### 4.2 改动：`zylos-lark/hooks/post-install.js`

```js
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');
const bundlesDir = path.join(skillRoot, 'skills');

mkdirSync(bundlesDir, { recursive: true });

function ensureXcSkills() {
  try {
    execSync('npx --no-install xc-skills --version', { stdio: 'ignore' });
  } catch {
    console.log('[zylos-lark] installing xc-skills globally...');
    execSync('npm install -g xc-skills', { stdio: 'inherit' });
  }
}

function installLarkCli() {
  const target = path.join(bundlesDir, 'lark-cli');

  if (existsSync(target)) {
    console.log('[zylos-lark] lark-cli already present, skipping');
    return;
  }

  console.log('[zylos-lark] installing lark-cli into', bundlesDir);
  execSync(
    `npx xc-skills add https://github.com/larksuite/cli --out "${bundlesDir}" -y`,
    { stdio: 'inherit' }
  );
}

try {
  ensureXcSkills();
  installLarkCli();
} catch (err) {
  console.warn('[zylos-lark] lark-cli bundle install failed:', err.message);
}
```

要点：

- 幂等：子目录已存在则跳过。
- 路径绝对化：`--out` 传绝对路径。
- `xc-skills` 全局安装需要 npm 全局权限，可能要 `sudo`；无权限环境下可以改用 `npx xc-skills@latest`，但每次冷启动会拉一次。
- install 末尾打印一次性的认证下一步指引，需要用户运行 `auth login`（交互式）。

### 4.3 改动：`zylos-lark/SKILL.md`

增加 `Bundled Sub-skills` 章节：

```md
## Bundled Sub-skills

zylos-lark 安装时会自动把若干官方 / 第三方 Lark 工具捆绑进 `./skills/` 子目录。

上层 agent 读到本 `SKILL.md` 时应知道下列能力存在并可调用。

### lark-cli（官方 Larksuite CLI）

- 来源：<https://github.com/larksuite/cli>
- 位置：`<skill-root>/skills/lark-cli/`
- 调用：参见该目录下自带的 `SKILL.md` / `README`
- 能力范围：以 `lark-cli` 仓库 `README` 为准，待填充。
- 认证：User 级 OAuth，需用户在本机手动完成 `lark-cli config init --new` 和 `lark-cli auth login --recommend`。
```

### 4.4 错误与回滚策略

| 失败点 | 行为 | 用户感知 |
| --- | --- | --- |
| `zylos-lark` 主体安装失败 | 中止 + 回滚 | 与改前一致 |
| `npm install -g xc-skills` 失败 | 中止 + 回滚 | 安装失败 |
| `xc-skills add` 失败 | 中止 + 回滚 | 安装失败 |

## 5. 已验证决策

- 通过在 `add.js` 中硬编码实现下面指令，可以正常把 `lark-cli` 安装到 `zylos-lark` 的子目录中：

  ```bash
  npm install -g xc-skills
  npx xc-skills add https://github.com/larksuite/cli --out {目录} -y
  ```

- `lark-cli` 还使用 User 级 OAuth，与 `zylos-lark` 的 App 级凭据是两套独立体系。

## 6. 待验证

- `add.js` 当前是否已经调用 `post-install` 钩子？
- 升级路径：`zylos upgrade lark` 是否同步升级 `skills/lark-cli`？本次不做。
- 多 runtime 影响：Claude Code / Codex 都会读 `SKILL.md`，理论上无差异。
- `appId` 以及 `appSecret` 的认证复用问题。

## 7. 测试方案

### 单测

`hooks/post-install.js`：

- mock `xc-skills` 已装。
- mock `xc-skills` 未装。
- mock 安装失败。

### 集成测试

- 干净环境执行 `zylos add lark`，断言 `skills/lark-cli/` 存在。
- 再次执行，断言跳过且无报错。
- 模拟离线，断言主体仍成功并出现 warning。

### 手动 checklist

- Claude 读 `SKILL.md` 后能描述出 bundled `lark-cli`。
- `npm run cli test` 通过。
- PM2 `zylos-lark` 重启正常。

## 8. 问题

1. 本地验证发现，把 `lark-cli` 的 `skills` 作为子目录安装到 `zylos-lark` 的目录中后，即使不修改 `SKILL.md`，agent 已经能自动识别 skill 并且识别成单独的 skill。还需要在 skill 声明吗？
2. `lark-cli` 需要两个认证。一个是 appId 应用级认证，和 `zylos-lark` 一致；`lark-cli` 的 app 认证是通过跳转链接的形式完成，可以保证过程中 `appSecret` 不会明文出现。`zylos-lark` 会重复要求再填入一次 `appId` + `appSecret`，是否可以让 `zylos-lark` 复用 `lark-cli` 的认证？
3. 另一个是 user 级认证。user 认证应该放在 `zylos add lark` 安装后让用户认证，还是在用户使用到 skills 时由 agent 提示用户进行认证？
