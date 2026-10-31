# VPS Pilot

一个简洁的中文 Vultr VPS 创建和管理页面。用户使用自己的 Vultr API Key 创建服务器，账单和资源都保留在用户自己的 Vultr 账户内。

部署到 Cloudflare Workers 后，使用你自己的 Workers 地址访问。

## 功能

- Vultr 注册、充值、API 获取引导
- 本机浏览器保存 API Key 选项
- 选择服务器地区和基础套餐
- 调用 Vultr API 创建 Ubuntu LTS 服务器
- 显示 VPS 的 IP、SSH 用户名和初始密码
- 支持删除当前创建的服务器
- 提供节点配置说明，方便继续完成客户端导入配置

## 本地运行

```bash
python3 server.py --host 0.0.0.0 --port 8791
```

打开：

```text
http://127.0.0.1:8791/
```

局域网访问时使用服务器的内网 IP 和端口。

## Cloudflare Workers 部署

项目使用 Cloudflare Workers、静态资源和 KV。`wrangler.jsonc` 里的 KV 命名空间 ID 只在创建该命名空间的 Cloudflare 账户中有效，换环境部署前请改成自己的 ID。

```bash
npm install
npx wrangler login
npx wrangler deploy
```

## 安全建议

- 使用 HTTPS 部署，避免 API Key 在明文网络中传输。
- 不要把 `.env`、`.dev.vars`、本地工作记录、服务缓存、日志或用户密钥提交到仓库。
- GitHub 和 Cloudflare 的访问令牌只通过环境变量或各自的登录工具提供。

## 数据说明

- `vultr-regions.json` 和 `vultr-plans-vc2.json` 是页面使用的 Vultr 地区和套餐数据。
- 教程截图不随仓库发布。自建需要配图时，把你自己的图片放到 `uploads/`（本地 Python）或 `public/uploads/`（Workers）。这两个目录已被 Git 忽略。
- 用户选择记住 API Key 后，Key 会保存在当前浏览器的 `localStorage`。
- Cloudflare Workers 版本会在 KV 中临时保存 API 会话和创建任务，分别用于当前操作和后续查询、删除；任务记录最长保留 24 小时。
- 本地 Python 版本只在进程内存中保存会话和任务，服务重启后自动清空。

## 目录

```text
index.html
styles.css
app.js
server.py
worker.js
wrangler.jsonc
package.json
vultr-regions.json
vultr-plans-vc2.json
public/
```
