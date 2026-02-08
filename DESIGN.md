# zylos-lark 详细设计文档

**版本**: v1.0
**日期**: 2026-02-08
**作者**: Zylos Team
**仓库**: https://github.com/zylos-ai/zylos-lark
**状态**: 已实现

---

## 一、概述

### 1.1 组件定位

zylos-lark 是 Zylos 的通讯组件，负责通过飞书/Lark Webhook API 实现用户与 Claude Agent 的双向消息交互。

| 属性 | 值 |
|------|-----|
| 类型 | 通讯组件 (Communication) |
| 优先级 | P0 |
| 依赖 | C4 Communication Bridge |
| 基础代码 | zylos-infra/lark-agent (~80% 复用) |

### 1.2 核心功能

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 私聊消息接收 | 接收授权用户的私聊消息 | P0 |
| 消息发送 | 通过 C4 发送消息到指定用户/群 | P0 |
| Owner 自动绑定 | 首个私聊用户自动成为管理员 | P0 |
| 用户白名单 | 限制只有授权用户可使用 | P0 |
| 群聊 @mention | 接收群聊中 @bot 的消息 | P1 |
| Smart Groups | 接收指定群的所有消息 | P1 |
| 图片接收 | 下载并传递图片路径给 Claude | P1 |
| 文件接收 | 下载并传递文件路径给 Claude | P2 |
| 群上下文 | @mention 时携带最近群聊消息 | P1 |

### 1.3 不包含的功能

- 语音消息处理
- 视频处理
- 飞书审批/日程主动创建 (通过 CLI 实现)
- 飞书卡片消息交互

---

## 二、目录结构

### 2.1 Skills 目录 (代码)

```
~/zylos/.claude/skills/lark/
├── SKILL.md              # 组件元数据 (v2 格式，含 lifecycle)
├── package.json          # 依赖定义
├── ecosystem.config.cjs  # PM2 配置
├── scripts/
│   └── send.js           # C4 标准发送接口
├── hooks/
│   ├── post-install.js   # 安装后钩子 (创建目录、配置 PM2)
│   ├── pre-upgrade.js    # 升级前钩子 (备份配置)
│   └── post-upgrade.js   # 升级后钩子 (配置迁移)
└── src/
    ├── index.js          # 主程序入口 (Webhook 服务器)
    ├── cli.js            # Lark API CLI 工具
    ├── admin.js          # 管理 CLI
    └── lib/
        ├── config.js     # 配置加载模块
        ├── client.js     # API 认证客户端
        ├── message.js    # 消息收发
        ├── document.js   # 文档/表格操作
        ├── calendar.js   # 日历查询
        ├── chat.js       # 群组管理
        └── contact.js    # 联系人查询
```

### 2.2 Data 目录 (数据)

```
~/zylos/components/lark/
├── config.json           # 运行时配置
├── group-cursors.json    # 群消息游标 (跟踪已处理消息)
├── user-cache.json       # 用户名缓存
├── media/                # 媒体文件存储 (图片、文件等)
└── logs/                 # 日志目录 (PM2 管理)
    ├── out.log
    ├── error.log
    └── <chat_id>.log     # 按会话存储的消息日志
```

---

## 三、架构设计

### 3.1 组件架构图

```
┌─────────────────────────────────────────────────────────┐
│                     zylos-lark                           │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐    ┌──────────────┐                   │
│  │  index.js    │───▶│  config.js   │                   │
│  │  (Express)   │    │  白名单+Owner │                   │
│  └──────┬───────┘    └──────────────┘                   │
│         │                                                │
│         │ Webhook 接收                                   │
│         ▼                                                │
│  ┌──────────────┐                                       │
│  │  message.js  │  下载媒体到本地                        │
│  └──────┬───────┘                                       │
│         │                                                │
│         ▼                                                │
│  ┌──────────────────────────────────┐                   │
│  │ c4-receive (comm-bridge)         │ → C4 Bridge       │
│  └──────────────────────────────────┘                   │
│                                                          │
│  ┌──────────────┐                                       │
│  │  send.js     │  ← C4 调用发送消息                    │
│  └──────────────┘                                       │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 3.2 模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| 主程序 | index.js | Express Webhook 服务器、事件监听、消息格式化、调用 c4-receive |
| 配置 | lib/config.js | 加载 .env + config.json，配置热更新 |
| 客户端 | lib/client.js | Lark API 认证 (app_id + app_secret → tenant_access_token) |
| 消息 | lib/message.js | 发送/接收消息，文件上传/下载 |
| 文档 | lib/document.js | 文档读取、表格读写 |
| 日历 | lib/calendar.js | 日历事件查询 |
| 群组 | lib/chat.js | 群列表、搜索、成员查询 |
| 联系人 | lib/contact.js | 用户信息查询 |
| 发送 | scripts/send.js | C4 标准接口，发送文本和媒体 |
| 管理 | src/admin.js | CLI 管理配置 (群组、白名单、Owner) |
| CLI | src/cli.js | Lark API 命令行工具 |

---

## 四、C4 集成

### 4.1 接收流程 (Lark → Claude)

```
用户发送消息
     │
     ▼
┌─────────────┐
│  index.js   │  监听 Lark Webhook
└─────┬───────┘
      │ 1. 解密 (如有 encrypt_key)
      │ 2. Owner / 白名单验证
      │ 3. 群组权限检查
      ▼
┌─────────────┐
│ 格式化消息  │
└─────┬───────┘
      │ 格式: "[Lark DM] username said: 消息内容"
      │       "[Lark GROUP] username said: [context] 消息内容"
      ▼
┌─────────────┐
│ c4-receive  │  C4 Bridge 接口
└─────┬───────┘
      │ --channel lark
      │ --endpoint <chat_id>
      │ --content "..."
      ▼
┌─────────────┐
│   Claude    │  处理消息
└─────────────┘
```

### 4.2 发送流程 (Claude → Lark)

```
Claude 需要回复
      │
      ▼
┌─────────────┐
│  c4-send    │  C4 Bridge
└─────┬───────┘
      │ c4-send lark <chat_id> "消息内容"
      ▼
┌──────────────────────────────────────┐
│ ~/zylos/.claude/skills/lark/scripts/send.js │
└─────┬────────────────────────────────┘
      │ 1. 解析参数
      │ 2. 检查媒体前缀 [MEDIA:type]
      │ 3. 调用 Lark API
      ▼
┌─────────────┐
│ Lark        │  用户收到消息
└─────────────┘
```

### 4.3 send.js 接口规范

```bash
# 位置: ~/zylos/.claude/skills/lark/scripts/send.js
# 调用: node send.js <chat_id> <message>
# 返回: 0 成功, 非 0 失败

# 纯文本
node send.js "oc_xxx" "Hello!"

# 发送图片
node send.js "oc_xxx" "[MEDIA:image]/path/to/photo.jpg"

# 发送文件
node send.js "oc_xxx" "[MEDIA:file]/path/to/document.pdf"
```

### 4.4 消息格式规范

**接收消息格式:**

```
# 私聊
[Lark DM] Howard said: 你好

# 群聊 @mention (带上下文)
[Lark GROUP] Howard said: [Group context - recent messages before this @mention:]
[Alice]: 今天需要部署吗?
[Bob]: 等我确认一下

[Current message:] @Zylos 帮我看一下

# 带图片
[Lark DM] Howard said: [image] 这是什么 ---- file: ~/zylos/components/lark/media/lark-xxx.png
```

---

## 五、配置设计

### 5.1 config.json 结构

```json
{
  "enabled": true,
  "webhook_port": 3457,

  "bot": {
    "encrypt_key": ""
  },

  "owner": {
    "bound": false,
    "user_id": "",
    "open_id": "",
    "name": ""
  },

  "whitelist": {
    "enabled": false,
    "private_users": [],
    "group_users": []
  },

  "allowed_groups": [],
  "smart_groups": [],

  "proxy": {
    "enabled": false,
    "host": "",
    "port": 0
  },

  "message": {
    "context_messages": 10
  }
}
```

### 5.2 配置说明

| 字段 | 类型 | 说明 |
|------|------|------|
| enabled | boolean | 组件启用开关 |
| webhook_port | number | Webhook 监听端口 |
| bot.encrypt_key | string | 飞书事件加密密钥 (可选) |
| owner.bound | boolean | 是否已绑定 Owner |
| owner.user_id | string | Owner 的 user_id |
| owner.open_id | string | Owner 的 open_id |
| owner.name | string | Owner 姓名 |
| whitelist.enabled | boolean | 白名单开关 |
| whitelist.private_users | string[] | 私聊白名单 |
| whitelist.group_users | string[] | 群聊白名单 |
| allowed_groups | object[] | 允许 @mention 的群组 |
| smart_groups | object[] | 监听所有消息的群组 |
| proxy.enabled | boolean | 代理开关 |
| message.context_messages | number | 群上下文消息数 |

### 5.3 环境变量 (~/zylos/.env)

```bash
# Lark App 凭证 (必须)
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
```

---

## 六、安全设计

### 6.1 Owner 自动绑定

**设计原则**: 第一个私聊用户自动成为 Owner (管理员)

```
用户发送私聊消息
      │
      ▼
┌─────────────────┐
│ 检查 owner      │
│ bound == false? │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
  未绑定     已绑定
    │         │
    ▼         ▼
绑定为 owner   走普通验证流程
保存 config
```

**绑定时记录**: user_id, open_id, name

### 6.2 用户验证流程

```
用户发送消息
      │
      ▼
┌─────────────────┐
│ 是 Owner?       │ → Yes → 放行
└────────┬────────┘
         │ No
         ▼
┌─────────────────┐
│ 白名单关闭?     │ → Yes → 放行
└────────┬────────┘
         │ No (白名单开启)
         ▼
┌─────────────────┐
│ 在白名单中?     │ → Yes → 放行
└────────┬────────┘
         │ No
         ▼
       忽略消息
```

### 6.3 群组权限

| 群组类型 | @mention 响应 | 接收所有消息 | 权限要求 |
|----------|:---:|:---:|---------|
| smart_groups | Y | Y | 无 |
| allowed_groups | Y | N | 白名单或 Owner |
| 其他群 | Owner 可 | N | 仅 Owner |

---

## 七、与 Telegram 组件的差异

| 方面 | zylos-telegram | zylos-lark |
|------|---------------|------------|
| 协议 | Telegram Bot API (long polling) | Lark Webhook (HTTP POST) |
| 入口 | bot.js (Telegraf) | index.js (Express) |
| 认证 | Bot Token | App ID + Secret → tenant_access_token |
| 消息加密 | 无 | AES-256-CBC (可选) |
| Owner 标识 | chat_id + username | user_id + open_id |
| 白名单结构 | chat_ids[] + usernames[] | private_users[] + group_users[] |
| CLI 工具 | 无 | cli.js (文档/表格/日历/群组) |
| 额外功能 | 无 | 表格读写、文档访问、日历查询 |

---

## 八、服务管理

### 8.1 PM2 配置

```javascript
// ecosystem.config.cjs
const path = require('path');
const os = require('os');

module.exports = {
  apps: [{
    name: 'zylos-lark',
    script: 'src/index.js',
    cwd: path.join(os.homedir(), 'zylos/.claude/skills/lark'),
    env: { NODE_ENV: 'production' }
  }]
};
```

### 8.2 服务命令

```bash
pm2 start ~/zylos/.claude/skills/lark/ecosystem.config.cjs
pm2 stop zylos-lark
pm2 restart zylos-lark
pm2 logs zylos-lark
```

---

## 九、生命周期管理 (v2 Hooks)

### 9.1 安装/卸载流程

```bash
# 安装
zylos install lark
# 1. git clone 到 ~/zylos/.claude/skills/lark
# 2. npm install
# 3. 创建 data_dir
# 4. PM2 注册服务
# 5. 执行 post-install hook

# 升级
zylos upgrade lark
# 1. pre-upgrade hook (备份配置)
# 2. git pull
# 3. npm install
# 4. post-upgrade hook (配置迁移)
# 5. PM2 重启服务

# 卸载
zylos uninstall lark [--purge]
# 1. PM2 删除服务
# 2. 删除 skill 目录
# 3. --purge: 删除数据目录
```

---

## 十、验收标准

- [ ] `zylos install lark` 可在全新环境完成安装
- [ ] `node send.js <chat_id> <message>` 正确发送消息
- [ ] 私聊消息正确传递到 c4-receive
- [ ] 群聊 @mention 带上下文传递到 c4-receive
- [ ] 图片下载并传递路径
- [ ] Owner 自动绑定流程正常
- [ ] Owner 可在任意群 @bot 触发响应
- [ ] admin.js 可正确管理配置
- [ ] `zylos upgrade lark` 保留用户配置并执行迁移
- [ ] `zylos uninstall lark` 正确清理

---

## 附录

### A. 依赖列表

```json
{
  "dependencies": {
    "@larksuiteoapi/node-sdk": "^1.0.0",
    "axios": "^1.6.0",
    "dotenv": "^16.4.5",
    "express": "^4.18.2",
    "form-data": "^4.0.0"
  }
}
```

### B. 参考资料

- [飞书开放平台文档](https://open.feishu.cn/document/)
- [飞书 Node SDK](https://github.com/larksuite/node-sdk)
- [zylos-telegram DESIGN.md](../zylos-telegram/DESIGN.md)

---

*文档结束*
