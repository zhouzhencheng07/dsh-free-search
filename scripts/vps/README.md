# 手机访问 VPS 部署（远程层）

链路：手机 → `https://<域名>`（caddy, VPS）→ frp 隧道 → PC 网关 `127.0.0.1:3090` → dsh web。

> 令牌校验全部在 **PC 网关**：VPS 上不存任何密钥，被攻破也只是死隧道端点。
> 局域网层不涉及本目录——网关随 dsh-kit 启用即监听，二维码面板直接给局域网链接。

## 0. 前置

- VPS 已装 caddy（官方包自带 systemd）与 frp 服务端；域名 A 记录指向 VPS。
- 中国大陆节点需域名已 ICP 备案，否则换香港等境外节点。
- PC 上 dsh-kit 设置卡「启用手机访问」已打开并重启过 dsh（否则 3090 没人听）。

## 1. VPS 侧

```bash
# frps
sudo mkdir -p /etc/frp /usr/local/bin/frp
sudo cp frps.toml /etc/frp/frps.toml        # 改 auth.token！
sudo cp frps.service /etc/systemd/system/frps.service
# frp 二进制自行从 github releases 解压到 /usr/local/bin/frp/
sudo systemctl daemon-reload && sudo systemctl enable --now frps

# caddy
sudo cp Caddyfile /etc/caddy/Caddyfile      # 把 dsh.example.com 换成你的域名
sudo systemctl reload caddy
```

阿里云安全组放行：`22/tcp`、`7000/tcp`(frpc 连入)、`80/tcp + 443/tcp`(caddy)。
**不放行 8443** —— 它只是 frp 在 VPS 本机回环开的回源口。

## 2. PC 侧

1. frpc.exe 与 frpc.toml 放 `C:\tools\frp\`（改好 IP/token）。
2. 管理员 PowerShell 执行 `.\register-frpc-task.ps1` 注册开机自启。
3. 验证：`Test-NetConnection 你的VPS -Port 7000` 通即可。

## 3. 打通验证

1. PC 浏览器打开 dsh → 手机访问面板 → 复制**远程**链接。
2. 手机浏览器打开该链接 → 应看到 dsh GUI（首次走 `?k=` 种 Cookie）。
3. 面板点「刷新链接」→ 旧链接立即 404，新二维码重新扫码。

## 故障速查

| 现象 | 排查 |
|---|---|
| 远程打不开、局域网正常 | `ssh vps "curl -sI http://127.0.0.1:8443"` 通=frp 正常，查 caddy/域名/备案 |
| frps 日志出现 token 错误 | 两端 auth.token 不一致 |
| 手机一直 404 | 链接被轮换过——回 PC 面板重新生成再扫 |
| 面板显示"网关未运行" | 设置卡开关没开或没重启 dsh；端口 3090 被占用也会这样（info.error 有说明） |
