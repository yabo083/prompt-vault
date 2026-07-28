# Prompt Vault

[English](README.md)

Prompt Vault 是一个可自行托管、文件优先的提示词工作台，用于编写提示词、管理图像资产，并以 Revision Lineage 保存提示词探索过程。

项目由 React/G6 浏览器工作区、Node.js 上的 Hono API、认证 CLI 和可移植 Agent Skill 组成。服务器是工作区的唯一写入者；浏览器、用户和 agent 统一通过 `/api/v2` 契约操作数据。

## 主要功能

- 编写正向提示词、负向提示词、备注、模型名称和生成参数。
- 为可编辑 Draft 添加并排序参考图与结果图。
- 保存不可变 Revision，并在画布上查看父子 Lineage。
- 从 Revision 继续、恢复、比较、标记和安全删除。
- 提示词和元数据保持为可读文件，不可变资产按内容哈希存储。
- 通过可撤销、浏览器授权的 CLI 操作一个或多个 Vault Host。
- 为兼容 Agent Skills 的客户端提供有安全门槛的 CLI 操作流程。

## Docker 快速部署

前置要求：Docker Engine 和 Docker Compose。

```bash
mkdir prompt-vault && cd prompt-vault
curl -LO https://raw.githubusercontent.com/yabo083/prompt-vault/main/compose.yaml
docker compose up -d
```

Prompt Vault 首次启动时会自动生成强随机 Host Token。通过持久数据卷读取：

```bash
docker compose exec prompt-vault cat /data/.vault-token
```

打开 <http://localhost:8767>，输入 Host Token。浏览器会将其交换为 HttpOnly 会话 Cookie。

Windows PowerShell：

```powershell
New-Item -ItemType Directory prompt-vault
Set-Location prompt-vault
Invoke-WebRequest https://raw.githubusercontent.com/yabo083/prompt-vault/main/compose.yaml -OutFile compose.yaml
docker compose up -d
docker compose exec prompt-vault cat /data/.vault-token
```

Docker 命名卷中保存工作区、Host Token 和 CLI 授权记录。重新创建或更新容器不会替换这些数据。

Compose 默认只接受 Docker 主机本机连接。如需主动开放到局域网，请设置 `PROMPT_VAULT_BIND=0.0.0.0`，并确保连接位于可信网络内或由 HTTPS 反向代理保护。

升级、备份、HTTPS 反向代理、令牌轮换、源码构建和 systemd 安装参见[部署文档](docs/deployment.md)。

## CLI

使用 Node.js 20.20 或更高版本安装独立 CLI：

```bash
npm install --global @miyako-lab/prompt-vault-cli
```

授权一个 Vault Host：

```bash
prompt-vault --host http://localhost:8767 auth login --name local
prompt-vault --json --host local theme list
```

CLI 会打开浏览器批准页面，并且不会存储 Host Token。批准后生成独立的 bearer credential；重新授权会替换旧凭据，也可以通过 `prompt-vault auth logout` 撤销。

自动化调用应使用 `--json`，获得稳定的 `{ ok, data }` 或 `{ ok, error }` 返回结构。完整命令和 agent 两步授权流程参见 [CLI 文档](docs/cli.md)。

## Agent Skill

仓库包含符合 [Agent Skills](https://agentskills.io/) 标准的操作 skill，指导 agent 通过 CLI 完成认证、检查、修改和回读验证。

OpenCode、Claude Code、Codex 等兼容客户端可使用以下命令安装：

```bash
npx skills add yabo083/prompt-vault
```

Skill 使用两步浏览器授权，使 agent 可以先返回批准 URL 和验证码，再等待用户操作。丢弃 Draft、强制覆盖、删除 Theme 和永久删除 Revision 都必须获得用户明确确认。

## 领域模型

- **Theme**：一次提示词探索，也是首页展示的工作单元。
- **Draft**：Theme 中唯一可编辑的创作状态。
- **Revision**：从 Draft 保存的不可变快照。
- **Lineage**：Revision 之间的父级关系。
- **Asset**：附加到 Draft 或 Revision 的参考图或结果图。
- **Vault Host**：拥有工作区并提供 HTTP 接口的 Prompt Vault 实例。

旧版工作区通过兼容读取投影到当前模型；仅打开旧工作区不会重写原文件。

## 存储与安全

工作区由普通目录、Markdown 文件和 JSON 元数据组成。Revision 资产会复制到按内容寻址的 `.assets/` 存储，并使用 SHA-256 校验。多文件修改使用锁、暂存目录和原子替换。

Host Token 具备浏览器管理员权限，应妥善保管。流量离开可信网络时必须使用 HTTPS。CLI credential 可以独立撤销，不应在用户之间复制。

数据卷应独立于应用版本进行备份。应用回滚和工作区回滚是两个不同操作。

## 本地开发

前置要求：Node.js 20.20 或更高版本，以及 npm。

```bash
git clone https://github.com/yabo083/prompt-vault.git
cd prompt-vault
npm ci
npm run dev:server
```

在另一个终端运行 `npm run dev` 启动 Vite 客户端。开发 API 默认监听 `http://127.0.0.1:8768`。

```bash
npm test
npm run typecheck
npm run build
```

架构、部署和 CLI 契约位于 [`docs/`](docs/architecture.md)。

## 路线图

1. **Revision 比较优化**：改进提示词文本、元数据、资产顺序和视觉结果的比较工作区。
2. **PVP 分享图片**：定义开放的 Prompt Vault Picture 格式。一张图片保持为干净的纯照片，同时嵌入提示词和生成参数，并尽量抵抗常见压缩与非恶意图像处理造成的信息损失。

## 许可证

Prompt Vault 使用 [GNU General Public License v3.0 or later](LICENSE) 开源。
