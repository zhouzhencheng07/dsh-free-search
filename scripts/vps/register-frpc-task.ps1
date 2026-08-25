# PC 端 frpc 开机自启 —— Windows 任务计划程序
# 前提：frpc.exe 放 C:\tools\frp\frpc.exe，配置在同目录 frpc.toml。
# 用管理员 PowerShell 执行一次即可（开机自启 + 掉线由 frpc 自身重连）。

# 注册任务：系统启动时以 SYSTEM 身份后台运行 frpc（无窗口）
schtasks /Create /TN "dsh-kit-frpc" /TR "C:\tools\frp\frpc.exe -c C:\tools\frp\frpc.toml" /SC ONSTART /RU SYSTEM /RL HIGHEST /F

# 常用操作：
#   立即启动   schtasks /Run /TN "dsh-kit-frpc"
#   停止       schtasks /End /TN "dsh-kit-frpc"
#   删除任务   schtasks /Delete /TN "dsh-kit-frpc" /F

# 备选（不建任务计划）：SSH 反向隧道一行替代 frp 全套——
#   ssh -N -R 127.0.0.1:8443:127.0.0.1:3090 user@你的VPS
# （VPS sshd 无需 GatewayPorts；断线重连可用 autossh 或任务计划包一层）
