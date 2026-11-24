# 捷士通智能会议

只保留捷士通简易版。浏览器和 Android App 使用同一套 React 页面：账号登录、录音、会议列表、回放、会议摘要和发言原文。原 Vue 完整版及其管理、主题和聊天界面已移除，`?view=full` 也不会再开启旧界面。现有 Flask API、数据库表和录音处理流程仍然保留，不需要为了更换前端而迁移会议资料。管理用户仍可通过受权限保护的 `/admin/*` API 操作。

## 目录

- [frontend/src](./frontend/src)：React 页面；[recording](./frontend/src/recording) 管理麦克风、分片上传和断网恢复。
- [src/meeting_web.py](./src/meeting_web.py)：Flask 为登录和会议页面提供入口资源、CSRF 和启动数据。
- [src/api/meetings.py](./src/api/meetings.py)：会议列表、详情和删除接口。
- [android](./android)：Android WebView 壳，以及后台录音通知、悬浮窗和权限引导。同一份网页不需要打包进 APK。

## 构建和运行

需要 Python 3.11（现有锁文件的 NumPy 要求）、Node.js 22.12 或更高版本，以及 `ffmpeg`、`ffprobe`。

```bash
npm --prefix frontend ci
npm --prefix frontend run build
uv venv --python 3.11 .venv
uv pip sync --python .venv/bin/python requirements.lock
```

前端产物位于 `static/meeting/`，不会提交到 Git。每次部署都要构建并发布这个目录；构建命令会先写新资源，再原子替换清单。保留现有的数据库、上传目录、会话密钥及转写／摘要配置。开发机可以在没有云服务密钥的情况下只测试录音保存：

```bash
mkdir -p "$PWD/data"
SQLALCHEMY_DATABASE_URI="sqlite:///$PWD/data/transcriptions.db" \
UPLOAD_FOLDER="$PWD/data/uploads" \
TRANSCRIPTION_CONNECTOR=funasr FUNASR_ALLOW_UNCONFIGURED=true FUNASR_USE_TEMP_UPLOAD=true \
DISABLE_VOICE_EMBEDDING_CHECK=true .venv/bin/python src/app.py
```

打开 `http://localhost:8899/`。空数据库可以通过注册页创建测试账号（如果配置允许），或使用已有部署的账号。开发服务器只用于本地；生产通过现有反向代理及 HTTPS 提供服务，保持 App 使用的 `/meeting/` 前缀并在 Flask 中正确配置 `SCRIPT_NAME` 或受信任的代理前缀。生产环境建议启用 `SESSION_COOKIE_SECURE=true`，并仅信任反向代理转发的请求头。

## 发布网页更新（不用重装 Android）

1. 修改 [frontend/src](./frontend/src) 中的登录或会议界面，重新执行 `npm --prefix frontend ci` 和 `npm --prefix frontend run build`。
2. 在服务器上先发布 `static/meeting/assets/` 中的新文件，再原子替换 `static/meeting/manifest.json`；如同时改了 Flask 路由或模板，要一起部署后端。本次从旧版迁移时必须发布后端和前端两部分。
3. App 下次重新加载网页就会取到新版。已打开的页面可从「更多选项 → 刷新页面版本」更新；录音、恢复或保存期间不会强制刷新。登录和会议 HTML 均为 `no-store`，JS/CSS 使用带内容哈希的文件名。

保留上一版 `assets/` 一段时间，便于已有页面继续使用和回滚。若修改麦克风权限、原生通知、应用图标或 APK 内置的生产地址，仍要发布并安装一个新 APK。

## 验证

```bash
.venv/bin/python -m unittest discover -s tests -v
```

测试使用隔离的 SQLite 数据库。Android 本地构建和模拟器流程见 [Android README](./android/README.md)。
