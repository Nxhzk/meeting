# 会议助手用 pi + srt，不用 Hermes、CubeSandbox 或 Docker

会议摘要改由 agent 生成，需要独立的会议会话、按用户共享的长期记忆，以及严格的数据隔离，而服务器只有一台 2C2G 的轻量机，上面还跑着不能受影响的销售管理系统。我们选了轻量的 pi（`@mariozechner/pi-coding-agent`），每次生成启动一个子进程，跑完即退出；只开放 pi 自带的 read/ls/grep/write/edit，用 `tool_call` 拦截扩展把路径锁在会议资料目录和记忆暂存文件内，外面再用 Anthropic 开源的 sandbox-runtime（`srt`）包一层，并用 systemd-run 限制资源。

## Considered Options

- **Hermes Agent**：自带终端、浏览器等全套工具和记忆，正因为工具多才需要重隔离，常驻进程在 2G 内存上偏重，功能也远超摘要所需。
- **腾讯 CubeSandbox**：基于 KVM 的微型虚拟机，要求物理机或支持 KVM 的环境，轻量机通常没有 `/dev/kvm`，还要常驻一套服务。
- **Docker / gVisor**：要装 Docker，内存吃紧，有影响宝塔和现有服务的风险。
- **直接调模型不用 agent**：实现最简单，但不能分段读长原文，也不能让 agent 自己决定写什么记忆。

## Consequences

- `srt` 版本号还是 0.0.x，必须锁定版本。它在 Linux 上依赖 bubblewrap 和非特权用户命名空间，上线前要在服务器上核实。
- 不开 bash：会议原文可能藏着诱导性的指令，agent 没有执行命令的能力，就不存在被诱导去执行命令这条路。
