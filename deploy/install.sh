#!/bin/bash
# 服务器端安装（OpenCloudOS 9，root 执行）：系统库、运行用户、代码、虚拟环境、依赖、systemd 单元。
# 用法：bash install.sh <jst-meeting.tar.gz>
# 可重复执行：已有的 /etc/jst-meeting/meeting.env 和 /var/lib/jst-meeting 不会被改动。
set -euo pipefail
PKG=${1:?用法: install.sh <jst-meeting.tar.gz>}
HERE=$(cd "$(dirname "$0")" && pwd)
N=jst-meeting
PIP_INDEX=${PIP_INDEX:-https://mirrors.tencent.com/pypi/simple/}

echo "== 系统库"
dnf install -y ffmpeg python3-pip file-libs cairo pango gdk-pixbuf2 shared-mime-info libpq libgomp

echo "== 用户和目录"
id $N >/dev/null 2>&1 || useradd -r -s /sbin/nologin -d /var/lib/$N $N
install -d -m 755 /opt/$N
install -d -m 750 -o root -g $N /etc/$N
install -d -m 700 -o $N -g $N /var/lib/$N
for d in instance uploads config tmp; do install -d -m 700 -o $N -g $N /var/lib/$N/$d; done

echo "== 代码"
NEW=/opt/$N/app.new
rm -rf $NEW && mkdir $NEW && tar -xzf "$PKG" -C $NEW
chown -R root:root $NEW && chmod -R a+rX $NEW
rm -rf /opt/$N/app.old
[ -d /opt/$N/app ] && mv /opt/$N/app /opt/$N/app.old
mv $NEW /opt/$N/app

echo "== 虚拟环境和依赖"
[ -x /opt/$N/venv/bin/python ] || python3.11 -m venv /opt/$N/venv
/opt/$N/venv/bin/python -m pip --version >/dev/null 2>&1 || /opt/$N/venv/bin/python -m ensurepip --upgrade
/opt/$N/venv/bin/python -m pip install --no-cache-dir --disable-pip-version-check --require-hashes \
    -i "$PIP_INDEX" -r /opt/$N/app/requirements.lock

echo "== 环境变量文件"
ENVF=/etc/$N/meeting.env
if [ ! -f $ENVF ]; then
  install -m 640 -o root -g $N "$HERE/meeting.env.example" $ENVF
  if [ -r /etc/jst-wb2api/model.key ]; then
    # 网关密钥只在服务器内部流转，不打印。
    python3 - "$ENVF" /etc/jst-wb2api/model.key <<'PY'
import re, sys
path, keyfile = sys.argv[1:3]
key = open(keyfile).read().strip()
text = open(path).read()
text = re.sub(r'^TEXT_MODEL_API_KEY=.*$', lambda m: 'TEXT_MODEL_API_KEY=' + key, text, flags=re.M)
open(path, 'w').write(text)
PY
  fi
else
  echo "已存在，保持不变"
fi

echo "== systemd"
install -m 644 "$HERE/jst-meeting.service" /etc/systemd/system/$N.service
systemctl daemon-reload
systemctl enable $N >/dev/null
echo "安装完成。启动：systemctl restart $N"
