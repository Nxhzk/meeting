#!/bin/bash
# jstai.com.cn 的 HTTPS 证书，加上宝塔 nginx 里 /jst-meeting/ 的转发。root 执行，可重复执行。
# 只做三件事：申请证书（certbot，自动续期）、给 80 端口加一条只管 /jst-meeting/ 的跳转、新增 443 站点。
# nginx -t 不通过时，自动还原所有改动。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DOMAIN=jstai.com.cn
NG=/www/server/nginx/sbin/nginx
VH=/www/server/panel/vhost/nginx
CONF=$VH/$DOMAIN.conf
EXT=$VH/extension/$DOMAIN
LIVE=/etc/letsencrypt/live/$DOMAIN

echo "== certbot"
dnf install -y certbot
if [ ! -f $LIVE/fullchain.pem ]; then
  certbot certonly --webroot -w /www/wwwroot/$DOMAIN -d $DOMAIN \
    --non-interactive --agree-tos --register-unsafely-without-email
fi
install -d /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/jst-meeting-nginx.sh <<HOOK
#!/bin/sh
$NG -s reload
HOOK
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/jst-meeting-nginx.sh
systemctl enable --now certbot-renew.timer

echo "== nginx"
[ -f $CONF.bak-jst-meeting ] || cp -a $CONF $CONF.bak-jst-meeting
install -d $EXT
install -m 644 "$HERE/nginx-http-redirect.conf" $EXT/jst-meeting-redirect.conf
if ! grep -q "extension/$DOMAIN" $CONF; then
  python3 - "$CONF" "$DOMAIN" <<'PY'
import re, sys
path, domain = sys.argv[1:3]
lines = open(path).read().split('\n')
for i, line in enumerate(lines):
    if re.match(r'^\s*location\s+/\s*\{', line):
        lines.insert(i, f'    include /www/server/panel/vhost/nginx/extension/{domain}/*.conf;\n')
        break
else:
    raise SystemExit('找不到 location / 块，未修改')
open(path, 'w').write('\n'.join(lines))
PY
fi
install -m 644 "$HERE/nginx-jst-meeting.conf" $VH/jst-meeting.conf

if $NG -t; then
  $NG -s reload
  echo "nginx 已重载"
else
  echo "nginx -t 失败，还原改动" >&2
  cp -a $CONF.bak-jst-meeting $CONF
  rm -f $VH/jst-meeting.conf $EXT/jst-meeting-redirect.conf
  $NG -t
  exit 1
fi
