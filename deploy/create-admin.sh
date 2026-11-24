#!/bin/bash
# 创建（或重置密码的）管理员账号。root 执行。
# 不给密码时生成随机密码，只打印这一次；用 JST_PASSWORD 环境变量可以指定密码（不会被打印）。
# 用法：[JST_PASSWORD=...] bash create-admin.sh <用户名(≤20 字符)> <邮箱> [--reset]
set -euo pipefail
NAME=${1:?用法: create-admin.sh <用户名> <邮箱> [--reset]}
EMAIL=${2:?缺少邮箱}
RESET=${3:-}
N=jst-meeting
set -a; . /etc/$N/meeting.env; set +a
cd /opt/$N/app
SPEAKR_SKIP_BACKGROUND_TASKS=true NAME="$NAME" EMAIL="$EMAIL" RESET="$RESET" JST_PASSWORD="${JST_PASSWORD:-}" \
runuser -u $N -- /opt/$N/venv/bin/python - <<'PY'
import os, secrets
from src.app import app, bcrypt
from src.database import db
from src.models import User

name, email, reset = os.environ['NAME'], os.environ['EMAIL'], os.environ['RESET'] == '--reset'
given = os.environ.get('JST_PASSWORD')
password = given or secrets.token_urlsafe(12)
with app.app_context():
    user = User.query.filter_by(username=name).first()
    if user and not reset:
        raise SystemExit(f'账号 {name} 已存在；要重置密码请加 --reset')
    if not user:
        user = User(username=name, email=email, email_verified=True, is_admin=True,
                    ui_language='zh', output_language='Chinese')
        db.session.add(user)
    user.password = bcrypt.generate_password_hash(password).decode()
    db.session.commit()
    if given:
        print(f'账号 {name} 的密码已设为你指定的值')
    else:
        print(f'账号: {name}\n初始密码: {password}\n（请登录后尽快修改；此密码不会再显示）')
PY
