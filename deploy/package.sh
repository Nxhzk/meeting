#!/bin/bash
# 构建前端并打出"只含运行必需文件"的服务器包。在仓库根目录之外的任何位置都能执行。
# 包里有：后端 src（不含声纹校验样例音频）、templates、静态资源（前端编译产物、多语言文案、图片、sw.js）、
#         VERSION、requirements.lock。
# 包里没有：前端源码、测试、deploy、android、node_modules、.git、接口文档页的 swagger 脚本。
# 用法：bash deploy/package.sh [输出目录，默认 /tmp/jst-release]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-/tmp/jst-release}
cd "$ROOT"
npm --prefix frontend run build >/dev/null
rm -rf "$OUT" && mkdir -p "$OUT"
COPYFILE_DISABLE=1 tar \
  --exclude='__pycache__' --exclude='*.pyc' --exclude='.DS_Store' \
  --exclude='static/meeting/.publish-*' \
  --exclude='static/vendor' --exclude='src/assets' \
  -czf "$OUT/jst-meeting.tar.gz" src templates static VERSION requirements.lock
echo "包: $OUT/jst-meeting.tar.gz  ($(du -h "$OUT/jst-meeting.tar.gz" | cut -f1)，$(tar -tzf "$OUT/jst-meeting.tar.gz" | grep -vc '/$') 个文件)"
shasum -a 256 "$OUT/jst-meeting.tar.gz"
# 防呆：这些绝不该出现在服务器包里
if tar -tzf "$OUT/jst-meeting.tar.gz" | grep -E '(^|/)(frontend|tests|deploy|android|node_modules|\.git)(/|$)|\.jsx$|\.map$'; then
  echo "包里混进了不该有的文件" >&2; exit 1
fi
