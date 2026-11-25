#!/bin/bash
# 在本机跑一套完整的会议系统，用来测试会议助手和新界面。
#
# 数据放在仓库下的 data-local/（已在 .gitignore 里），和服务器完全隔离。
# 密钥从 ~/.jst-meeting-local.env 读取（只在本机，权限 600，不进 git）：
#   ASSISTANT_MODEL_BASE_URL   模型接口（服务器 workbuddy 的公网路径，…/v1）
#   ASSISTANT_MODEL_API_KEY    模型接口的密钥
#   ALIYUN_ASR_API_KEY         阿里云百炼 Fun-ASR 的 key（不填就读 ~/.aliyun-asr-key）
#   S3_*                       暂存音频的 COS 桶（阿里云转写要从这里取音频）
# 没有转写密钥时录音照样能保存，只是不转写。
#
# 用法：bash deploy/run-local.sh            （端口固定 8899，由 src/app.py 决定）
#       第一次运行会安装依赖、构建前端，并在没有管理员时创建一个（用户名 admin，密码打印一次）。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=8899
DATA="$ROOT/data-local"
SECRETS="$HOME/.jst-meeting-local.env"
cd "$ROOT"

[ -x .venv/bin/python ] || { echo "缺少 .venv：先按 README 执行 uv venv 与 uv pip sync" >&2; exit 1; }
[ -d assistant/node_modules ] || npm --prefix assistant ci --no-audit --no-fund
[ -d frontend/node_modules ] || npm --prefix frontend ci --no-audit --no-fund
npm --prefix frontend run build >/dev/null
mkdir -p "$DATA/uploads"

set -a
SQLALCHEMY_DATABASE_URI="sqlite:///$DATA/transcriptions.db"
UPLOAD_FOLDER="$DATA/uploads"
SECRET_KEY_FILE="$DATA/session.key"
SESSION_COOKIE_SECURE=false
ALLOW_REGISTRATION=false
DISABLE_VOICE_EMBEDDING_CHECK=true
TRANSCRIPTION_CONNECTOR=aliyun_asr
ALIYUN_ASR_ALLOW_UNCONFIGURED=true
ASSISTANT_SANDBOX=srt
TEXT_MODEL_NAME=cn:deepseek-v4.1-flash
TEXT_MODEL_EXTRA_BODY='{"thinking":{"type":"enabled"},"reasoning_effort":"max"}'
LLM_REQUEST_TIMEOUT=1800
[ -f "$SECRETS" ] && . "$SECRETS"
set +a
if [ -z "${ALIYUN_ASR_API_KEY:-}" ] && [ -f "$HOME/.aliyun-asr-key" ]; then
  export ALIYUN_ASR_API_KEY=$(tr -d '[:space:]' < "$HOME/.aliyun-asr-key")
fi
# 标题生成走同一个模型接口
export TEXT_MODEL_BASE_URL=${TEXT_MODEL_BASE_URL:-${ASSISTANT_MODEL_BASE_URL:-}}
export TEXT_MODEL_API_KEY=${TEXT_MODEL_API_KEY:-${ASSISTANT_MODEL_API_KEY:-}}
[ -n "$TEXT_MODEL_BASE_URL" ] || echo "提示：$SECRETS 里没有 ASSISTANT_MODEL_BASE_URL，摘要会生成失败。" >&2

# 第一次：建管理员
SPEAKR_SKIP_BACKGROUND_TASKS=true .venv/bin/python - <<'PY'
import secrets
from src.app import app, bcrypt
from src.database import db
from src.models import User
with app.app_context():
    if not User.query.filter_by(is_admin=True).first():
        password = secrets.token_urlsafe(9)
        user = User(username='admin', email='admin@localhost.test', email_verified=True, is_admin=True,
                    ui_language='zh', output_language='Chinese')
        user.password = bcrypt.generate_password_hash(password).decode()
        db.session.add(user)
        db.session.commit()
        print(f'\n本地管理员：admin / {password}（只显示这一次，请记下）\n')
PY

echo "打开 http://localhost:$PORT/   （Ctrl+C 停止）"
exec .venv/bin/python src/app.py
