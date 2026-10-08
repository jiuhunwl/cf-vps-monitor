![Stars](https://img.shields.io/github/stars/jiuhunwl/cf-vps-monitor?style=for-the-badge&logo=github&label=Stars&color=ffb000) ![Forks](https://img.shields.io/github/forks/jiuhunwl/cf-vps-monitor?style=for-the-badge&logo=github&label=Forks&color=2ea44f) ![License](https://img.shields.io/github/license/jiuhunwl/cf-vps-monitor?style=for-the-badge&color=blue)
# CF VPS Monitor

CF VPS Monitor 是一个轻量 VPS 探针面板，使用 Cloudflare Workers 承载前端、API、实时连接和定时任务，使用 Durable Objects 协调实时状态，使用 Supabase Postgres 保存配置和历史数据，使用 Go Agent 在服务器上采集指标。


## 特性

- **服务器监控**：在线状态、CPU、GPU、内存、Swap、磁盘、负载、温度、网络速率、月度流量、账单、到期时间、系统信息、IPv4/IPv6、进程数、TCP/UDP 连接数。
- **实时看板**：首页、节点详情页和后台首页通过 WebSocket 获取实时数据。
- **Ping 监控**：支持 ICMP、TCP、HTTP Ping 任务，可分配到全部节点或指定节点，并展示延迟历史。
- **网站监控**：支持 HTTP/HTTPS GET、HTTP/HTTPS HEAD 和 TCP 检测，支持期望状态码、超时、间隔、启停、隐藏、排序、手动检测和 Agent 节点侧探测。
- **后台管理**：节点增删改、批量隐藏/删除、拖拽排序、记录清理、Agent Token 轮换、安装命令生成、系统设置、审计日志、健康检查、容量估算、备份恢复、账号改名和改密。
- **Agent 升级**：后台面板一键把节点升级到最新或指定版本，支持批量分波、失败重试、降级二次确认；升级失败自动回滚到原版本，节点全程在线不中断业务。
- **通知**：支持 Telegram 、 SMTP Email 和 Webhook，可配置离线、到期、负载以及网站监控相关通知。
- **主题**：内置 `monitor` 和 `aurora` 主题，支持主题包、自定义 CSS、图片和字体资源。
- **管理员恢复**：首次登录时创建管理员；忘记账号或密码时，可在登录页用当前部署的 Supabase Secret key 重置唯一管理员。
- **省配额策略**：有实时观看者时 Agent 约 3 秒采集并上报；无人查看时约 120 秒采样并批量上报。可用节点数取决于 Ping 任务、访问量、上报方式以及数据库和实时服务的独立额度，请在后台容量估算中核对，不能仅凭 Worker 请求量保证免费运行 50 台。

节点温度目前仅支持 Linux 上可识别的 CPU/SoC 传感器，多个有效读数取最高值。没有传感器或读取失败，以及当前 Windows、macOS、FreeBSD 安装包，均显示“不可用”；真实 0°C 和负温度仍是有效读数。GPU 温度独立显示。旧 Agent 需要升级才能使用这一规则，旧历史中的 0 不会被猜测改写。

## 预览图

<img width="960" height="540" alt="cf-vps-monitor-promo-full-mobile" src="https://github.com/user-attachments/assets/78a5c78b-143c-4874-aa6e-4dbe17c3597d" />



## 架构

| 目录 | 说明 |
| --- | --- |
| `frontend/` | React + Vite + Radix UI + Tailwind，构建产物由 Workers Static Assets 托管 |
| `worker/` | Hono Worker、Durable Objects、Cron Triggers、Supabase HTTP RPC 数据层 |
| `agent/` | Go Agent，支持 WebSocket/HTTP 上报和 Unix/Windows 安装脚本 |
| `supabase/migrations/` | Supabase 表、索引、RLS、RPC、授权和默认数据 |
| `scripts/` | 部署和迁移清单生成脚本 |

## 运行时配置


| 名称                    | 类型       | 说明                                                                    |
| --------------------- | -------- | --------------------------------------------------------------------- |
| `SUPABASE_URL`        | Variable | Supabase Project URL，例如 `https://xxxx.supabase.co`                    |
| `SUPABASE_SECRET_KEY` | Secret   | Supabase Secret key，通常以 `sb_secret_` 开头；不要填写 Publishable key、anon key |
| `JWT_SECRET`          | Secret   | 后台会话签名密钥，必须至少 32 字节；英文/数字不少于 32 个字符                                   |

`SUPABASE_SERVICE_ROLE_KEY` 仅作为旧部署兼容变量保留；新部署请使用 `SUPABASE_SECRET_KEY`。

## 面板部署

在 Cloudflare 的 **Settings → Build → Build Variables and Secrets** 中设置 `NODE_VERSION=24`、`GO_VERSION=1.26.8`（与 `agent/go.mod` 保持一致）。Workers Builds 官方镜像已包含 Go，也能按 `go.mod` 自动选择工具链。部署入口会先运行前后端检查、构建和 JavaScript/Go 测试；检查失败时不会发布。

### Fork 本仓库部署【推荐，方便更新】


1. 在 [Supabase](https://supabase.com/dashboard/) 创建或选择项目。
2. 打开 Supabase 项目 **Project Overview** 页面复制 `Project URL`；打开 **Project Settings -> API Keys -> Publishable and secret API keys**，复制 **Secret keys** 中的 `default` Secret key，格式通常为 `sb_secret_...`。
3. Fork [本仓库](https://github.com/jiuhunwl/cf-vps-monitor) 得到自己的仓库。Cloudflare 只能连接你本人有权限的仓库，因此这一步不能省略。
4. **在你自己的 Fork 仓库里**打开 Actions，选择 **Agent Release**，点击 **Run workflow** 填入一个版本号（例如 `v1.1.0`），再点一次 **Run workflow**。该 workflow 会先跑一遍 CI，通过后再编译各平台 Agent 并发布 release。仓库已有的 release 不会被复用，版本号必须比历史版本更新。
   - 后台生成的安装命令默认从 `releases/latest/download` 取二进制、从源码分支取安装脚本，因此**必须至少发布过一个 release**，否则 Agent 安装会 404。
   - 如果你在后台给节点填了 `release-tag`，安装脚本会改为从该 tag 的 release 资产里取，这时更要保证对应版本已发布。
5. 打开 Cloudflare Dashboard 的 **Workers & Pages**，点击 **创建应用程序**， 点击**Continue with GitHub**。
6. 选择 GitHub 账号和刚创建的 Fork 仓库，点击**下一步**。
7. 展开 **高级设置** 配置三个变量 `SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`JWT_SECRET`。`JWT_SECRET` 必须至少 32 字节，英文/数字不少于 32 个字符。
8. 保持默认 **构建命令** `npm run build`，将 **部署命令** 设置为 `npm run deploy`。
9. 点击 **部署**。
10. 如果 Cloudflare 里创建的 Worker 名称不是 `cf-vps-monitor`，需要同步修改 Fork 仓库的 `wrangler.toml` 里的 `name`，两者必须一致。
11. 去 [Supabase](https://supabase.com/dashboard/account/tokens) 创建有效期 1 小时的 Access Token。
12. 打开 `https://你的 Worker 域名/db-init` 初始化数据库，首次部署后访问 `/admin/login` 创建管理员。



### 直接一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jiuhunwl/cf-vps-monitor)

1. 在 [Supabase](https://supabase.com/dashboard/) 创建或选择项目。
2. 打开 Supabase 项目 **Project Overview** 页面复制 `Project URL`；打开 **Project Settings -> API Keys -> Publishable and secret API keys**，复制 **Secret keys** 中的 `default` Secret key，格式通常为 `sb_secret_...`。
3. 点击 上面的**Deploy to Cloudflare**。
4. 登录 Cloudflare, 选择账号、仓库名和 Worker 名称。
5. 填入对应变量的值 `SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`JWT_SECRET`。`JWT_SECRET` 必须至少 32 字节，英文/数字不少于 32 个字符。
6. 保持默认 **构建命令** `npm run build`，将 **部署命令** 设置为 `npm run deploy`。
7. 点击 **部署**。
8. 去 [Supabase](https://supabase.com/dashboard/account/tokens) 创建有效期 1 小时的 Access Token。
9. 打开 `https://你的 Worker 域名/db-init` 初始化数据库，首次部署后访问 `/admin/login` 创建管理员。
10. 建议后续每次版本更新后都执行一次初始化数据库(不会丢失数据)。


## 命令行部署

适合本地开发或维护者。需要 Node.js 24 和 Go；Go 会依据 `agent/go.mod` 自动选择所需工具链。

```powershell
npm ci
npm run build
npx wrangler login
$env:SUPABASE_URL="https://xxxx.supabase.co"
npx wrangler secret put SUPABASE_SECRET_KEY
npx wrangler secret put JWT_SECRET
npm run deploy
```



## 使用流程

1. 登录后台。
2. 在“服务器”添加节点。
3. 打开节点安装命令，选择 Unix 自动检测或 Windows，复制安装命令。安装命令里的脚本地址来自源码分支、二进制来自 release；如果你部署的是自己的 Fork，请先确认该 Fork 里已经跑过 **Agent Release** 且存在 release，否则二进制会 404。
4. 在 VPS 上执行安装命令，等待 Agent 上线。
5. 需要 Ping 监控时，在“Ping”创建任务。
6. 需要网站监控时，在“网站”创建 HTTP/HTTPS 或 TCP 检测目标。
7. 需要告警时，在“通知”配置 Telegram、SMTP Email 或 webhook推送。


同一台服务器可以安装多个 Agent 实例。每个安装命令会带独立 `instance-id`，默认生成独立服务名和安装目录。

Unix 安装命令会自动判断 Linux、Alpine/OpenRC、macOS、FreeBSD，以及 root/非 root 环境。Linux 只有在 systemd 或 OpenRC 实际运行时才使用对应系统服务；没有可用服务管理器的容器会自动使用用户模式。也可加 `--install-mode user` 明确选择用户模式。

| 系统 | 预编译架构 | 系统安装 | 普通用户安装 |
| --- | --- | --- | --- |
| Debian/Ubuntu、RHEL 系等 Linux | amd64、arm64 | 活动 systemd | 支持 |
| Alpine/Gentoo 等 OpenRC Linux | amd64、arm64 | 活动 OpenRC | 支持 |
| macOS | Intel、Apple Silicon | LaunchDaemon | 支持 |
| FreeBSD | amd64 | 使用用户模式 | 支持 |
| Windows | x64 | 需要管理员，服务任务以 LocalService 运行 | 当前不支持非管理员安装 |

该表说明安装路径和发行包范围，不代表每个发行版、架构都经过实机验证。其他架构需要自行提供适配二进制或编译环境；未运行 systemd/OpenRC 的 Linux 不提供原生 SysV/runit 服务接入。

非 root 或 Serv00 这类共享主机会把程序、配置和日志保存在用户目录，用 `nohup` 启动后台进程。主机允许时会添加 `crontab @reboot`；缺少 crontab 或账号无权读写时，Agent 继续运行并明确提示未配置开机自启，不覆盖原有任务。`nohup` 不提供崩溃重启，开机自启还取决于主机是否启用 cron、是否允许常驻进程。

OpenRC 每次启动会准备服务账户专用日志并检查启动后进程存活，日志保留已有内容。系统服务的自定义安装路径必须允许服务账户进入；安装器不会放宽既有私有父目录权限。ICMP 与部分硬件指标取决于系统权限，不应把这些限制误当成 TCP/HTTP 或普通指标上报失败。

卸载单个 Unix 实例：

```bash
wget -qO- 'https://raw.githubusercontent.com/jiuhunwl/cf-vps-monitor/refs/heads/main/agent/install.sh' | sh -s -- --uninstall -i 实例ID
```

卸载单个 Windows 实例：

```powershell
.\install-windows.ps1 -Uninstall -i '实例ID'
```

只有执行 `--uninstall-all --yes` 或 `-UninstallAll -Yes` 才会清理本机全部 Agent 实例。

## 后台一键同步更新

后台固定检测 [jiuhunwl/cf-vps-monitor](https://github.com/jiuhunwl/cf-vps-monitor) `main` 分支的最新推送编码。进入后台 `关于 -> 版本更新`，保存“你的部署仓库地址”，以后检测到推送编码不一致时会显示同步入口。

> **从旧上游迁移过来的部署**：如果你此前把 `你的部署仓库地址` 填的是旧上游地址，请改成上面的本仓库地址（或你自己的 Fork）。旧上游已归档、不会再产生新提交，继续对着它做对比会一直显示“已是最新”。

### 从 v2.0.2 升级到 v2.0.3

1. 部署完成后，立即打开本站 `/db-init` 执行一次数据库升级。已有账号、节点及有效监控数据保留，无需清库或重建节点；网站图表会从升级后的新采样重新积累。
2. 原先使用非每月 1 日重置流量的节点，先在后台确认“流量重置日”，再更新 Agent。使用后台为原节点生成的新版安装命令原地更新即可，安装器会重启 Agent，无需重启 VPS。Agent 不会自动更新；由 Agent 执行的网站探测需要新版，旧版仍可上报普通指标和 Ping。
3. 首次升级 Agent 会重建流量统计基线，累计值可能降低或重新起算；修改流量重置日也会重建当期累计。

### 如果是 Fork 本仓库部署【推荐】

适合先 Fork 本仓库，再在 Cloudflare Workers Builds 里连接这个 Fork 仓库的部署方式。

1. 在后台 `关于 -> 版本更新`：
   - `你的部署仓库地址` 填你的 Fork 仓库地址，例如 `https://github.com/用户名/cf-vps-monitor`
   - 点击 `保存设置`
2. 后台检测到更新后，点击 `前往同步 Fork`，打开你的 Fork 仓库首页。
3. 在 GitHub 仓库文件列表上方点击 `Sync fork` 下拉菜单。
4. 确认上游提交后点击 `Update branch`。
5. 如果 GitHub 提示冲突，需要按提示创建 PR 或手动解决冲突。
6. Fork 更新产生的 push 会触发 Cloudflare Workers Builds 自动构建部署。
7. **更新后最好初始化一下数据库，否则可能无法使用**

### 如果是 Deploy Button 一键部署

Cloudflare 一键部署自动创建的仓库不保证包含可用的更新工作流，后台不再提供这类更新入口。需要后续稳定同步更新时，建议改用上面的 Fork 本仓库部署方式。


## Agent 升级

面板内置 Agent 升级功能，可把一个或多个节点原地升级到「最新版本」或「指定版本」，无需重新提供 `--server` / `--token`。

### 使用方式

1. 在后台节点列表选中一个或多个节点，点击「批量升级」，或在单节点行内点击「升级」。
2. 弹窗显示「将升级 N 个 / 已最新跳过 M 个」。已是最新版本的节点会被自动跳过，不会重复升级。
3. 选择目标版本（默认 `latest`，即当前仓库的最新 release）。**若目标版本低于节点当前版本，会要求二次确认**，并在 UI 上明确标注「降级」。
4. 点击确认后，前端按每批 5 个节点串行推进；**单个节点失败不会阻塞其余节点**。失败节点保留在列表里，可单独重试。

### 安全保证

- **强制校验和**：每个升级包都用官方 `SHA256SUMS` 校验后才替换二进制；校验失败立即中止，原二进制不动。
- **原子替换 + 自动回滚**：升级先暂存新版本，校验通过后原子替换并重启；重启后健康检查失败会自动回滚到原版本，节点保持在线。
- **失败不破坏运行实例**：任何环节失败（下载、校验、替换、重启、健康检查、回滚）节点都必须仍以原版本正常运行。
- **来源不可被面板注入**：下载来源（release base / proxy / ghproxy）由节点本地 root 监督进程的命令行参数决定，面板和 Worker 都不会把这三个字段下发到节点——这是为了防止任何持有面板权限的请求把节点导向攻击者控制的下载源绕过 SHA256。

### 权限模型

- 面板下发升级命令需要管理员登录态 + CSRF 校验（与其它后台写接口一致）。
- 节点侧执行升级命令的监督进程以 root 权限运行（这样才能替换二进制、重启系统服务），但**只接受来自本机 root 守护单元的任务**，不接受远程网络直接驱动。
- 升级请求里携带的 `requested_by` 字段会记录到审计日志，可追溯操作来源。

### Windows 边界

Windows 节点**不能由 Agent 自身替换**（运行中的 `.exe` 文件无法被改名/覆盖）。面板驱动的 Windows 升级会委托给 `install-windows.ps1 -Upgrade`：脚本先停止当前进程，再替换二进制，失败时回滚。这意味着 Windows 升级需要节点已安装带 `-Upgrade` 支持的安装脚本版本。

### 引导升级（仅一次）

面板驱动的升级要求节点**已装配带 root 监督单元的新版安装器**。更老的节点（安装于本功能发布之前）首次需要**手工跑一次安装脚本**来装配监督单元：

```bash
# Linux (amd64 / arm64)
bash <(curl -fsSL https://raw.githubusercontent.com/jiuhunwl/cf-vps-monitor/main/agent/install-linux.sh) --upgrade

# macOS / FreeBSD 等其它系统
bash <(curl -fsSL https://raw.githubusercontent.com/jiuhunwl/cf-vps-monitor/main/agent/install.sh) --upgrade
```

```powershell
# Windows (PowerShell 以管理员身份运行)
irm https://raw.githubusercontent.com/jiuhunwl/cf-vps-monitor/main/agent/install-windows.ps1 | iex
# 加 -Upgrade 参数执行升级
```

引导升级成功后，该节点即可被面板直接驱动升级；后续版本迭代无需再手工介入。

### 升级状态语义

每个升级命令的 `status` 取值与含义：

| 状态 | 含义 |
|---|---|
| `queued` | 命令已创建，等待节点拉取 |
| `dispatched` | 命令已下发到节点，等待执行开始 |
| `running` | 节点正在执行升级 |
| `success` | 升级成功，节点新版本已通过健康检查 |
| `already_latest` | 目标版本与当前版本相同，无需升级 |
| `failed` | 升级失败，已回滚到原版本，节点仍以原版本运行 |
| `rolled_back` | 升级失败且自动回滚成功（与 `failed` 区分：回滚这一动作本身也成功了） |
| `unverified` | 升级上报的版本与目标版本不符——可能是替换不完整或上报延迟，需要人工核对 |

> `success` 是「新进程上报了目标版本」的可信结论；Worker 会在上报版本与目标版本不符时把它降级为 `unverified`，所以 `unverified` 在 UI 上显著区别于 `success`。


## 本地开发

```bash
npm ci
npm run dev:frontend
npm run dev:worker
```

常用检查：

```bash
npm run build:migrations
npm run verify
cd agent && go test ./...
```


## 安全

- 后台登录使用 HttpOnly 会话 Cookie，非安全写请求需要 CSRF 校验。
- 登录失败会记录限流状态和审计日志。
- Agent 使用节点 Token 认证，后台可轮换节点 Token。
- Ping 与网站探测会拦截内网、回环、链路本地、组播、保留地址和元数据地址。
- Supabase 迁移启用 RLS，并对 RPC 函数显式 `revoke` / `grant`；需要 `security definer` 的函数固定 `search_path`。
- 忘记密码重置需要输入当前部署的 Supabase Secret key；该 key 只用于本次请求校验，不会被保存。

## 贡献与反馈

- **问题反馈 / 功能建议**：请在本仓库 [Issues](https://github.com/jiuhunwl/cf-vps-monitor/issues) 提交，尽量写清部署方式（Fork / Deploy Button / 命令行）、Worker 版本和可复现步骤。
- **提交代码**：从 `main` 开分支，提交前至少跑通 `npm run verify`（前端类型检查 + 构建 + `node --test` + Go 测试 + 安全扫描）。若改到仓库标识、安装脚本或发布流程，请再确认 `node agent/install-branch-consistency.test.mjs` 与 `node agent/repository-identity.test.mjs` 仍然通过。
- **仓库标识改动须知**：`owner/repo` 与默认分支在三处各存一份（三个安装脚本、前端 `frontend/src/utils/projectLinks.ts`、worker `worker/src/utils/project-repository.ts`），必须同步修改；只改一处会让后台安装命令、worker 的 `/agent/install*` 302 重定向与 `/update-check` 更新源指向不同仓库。
- **安全漏洞**：请不要开公开 Issue，更不要在 Issue 里给出可利用细节。

## 许可证

本项目使用 [MIT License](LICENSE)。

### 溯源说明

<!-- upstream-attribution:begin -->
本项目源自 MIT 许可的 **CF VPS Monitor** 项目。原上游仓库 `kadidalax/cf-vps-monitor` 已 **归档（archived，只读）** 且不再维护，无法再接收更新或合入 PR，本仓库因此作为独立项目继续维护：所有安装脚本、Worker 重定向、后台更新源与文档均以本仓库为准。MIT 许可允许在保留原始版权声明的前提下继续分发，`LICENSE` 正文中的版权声明予以保留。
<!-- upstream-attribution:end -->

上面这段由 `agent/repository-identity.test.mjs` 的溯源标记例外覆盖：该测试会全量扫描被跟踪文件、禁止出现已归档上游的标识，只允许这段标记区间内的溯源说明提及它。

关于 GitHub 的 "forked from" 标记：GitHub 不提供自助解除 fork 关系的能力，该标记保留不影响本仓库作为独立项目运行，也不会限制发布、Issues、Actions 或仓库设置。**维护者注意**：不要在本仓库点击 `Sync fork`，那会把本仓库拉回已归档的上游状态；本仓库的更新只接受来自本地开发的提交。

## 参考文档

- [Cloudflare Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Cloudflare Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Supabase Management API](https://supabase.com/docs/reference/api/introduction)
- [Supabase API Keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase Migrating to new API keys](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys)
- [Supabase Data API Security](https://supabase.com/docs/guides/api/securing-your-api)


## Star History

<a href="https://www.star-history.com/?repos=jiuhunwl%2Fcf-vps-monitor&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=jiuhunwl/cf-vps-monitor&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=jiuhunwl/cf-vps-monitor&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=jiuhunwl/cf-vps-monitor&type=date&legend=top-left" />
 </picture>
</a>
