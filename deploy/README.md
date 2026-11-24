# 部署到腾讯云（jstai.com.cn/jst-meeting/）

一台腾讯云轻量服务器（OpenCloudOS 9）：nginx（宝塔）负责 HTTPS 并把 `/jst-meeting/` 转发给本机 gunicorn；
摘要模型用同机的 WorkBuddy2API（`127.0.0.1:7864`，不对公网开放）；转写用腾讯云录音文件识别。

| 文件 | 作用 |
|---|---|
| `install.sh` | 装系统库、建用户和目录、解压代码、建虚拟环境、装依赖、写 systemd 单元 |
| `meeting.env.example` | 环境变量模板，安装后在 `/etc/jst-meeting/meeting.env` |
| `jst-meeting.service` | gunicorn 的 systemd 单元，监听 `127.0.0.1:18899` |
| `create-admin.sh` | 创建管理员账号，随机初始密码只显示一次 |
| `setup-https.sh` | 申请证书、加 nginx 转发；`nginx -t` 失败自动还原 |
| `nginx-*.conf` | 上一条脚本用到的 nginx 片段 |

## 发布

1. 本机构建并打包：`npm --prefix frontend run build`，再把 `src templates static VERSION requirements.lock` 打成 `jst-meeting.tar.gz`（不含 `__pycache__`）。
2. 把代码包和本目录放到服务器，执行 `bash install.sh jst-meeting.tar.gz`。
3. 编辑 `/etc/jst-meeting/meeting.env`，填 `ALIYUN_ASR_API_KEY`（百炼 API Key）和 `S3_*`（COS）。
4. `bash create-admin.sh <用户名> <邮箱>`，`bash setup-https.sh`，`systemctl restart jst-meeting`。

升级只需重复第 1、2 步和 `systemctl restart jst-meeting`；数据库、录音、会话密钥在 `/var/lib/jst-meeting`，不会被覆盖。
上一版代码保留在 `/opt/jst-meeting/app.old`，需要回滚时把它改回 `app` 再重启。

## 模型设置

- 摘要：`cn:deepseek-v4.1-flash`，思考档位 `max`（`TEXT_MODEL_EXTRA_BODY`），上下文 1,000,000 tokens，输出上限 393,216 tokens。
  转写文本不截断，各类调用的输出预算默认取模型最大值；要调低就设 `SUMMARY_MAX_TOKENS` 等环境变量。
- 转写：阿里云百炼 `fun-asr`（中英、带说话人分离）。录音先传到 COS，再把预签名链接交给阿里云识别，识别完即删。
