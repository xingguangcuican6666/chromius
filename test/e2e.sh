#!/bin/bash
# 端到端测试：fixture 子应用经 Chromius 接入共享宿主，验证「唯一浏览器进程」与「内存边际成本」。
set -u
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
ok()  { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

kill_matching() { # 安全地杀掉匹配进程（排除自身）
  local pat=$1
  for p in $(pgrep -f "$pat" 2>/dev/null); do
    [ "$p" = "$$" ] && continue
    kill "$p" 2>/dev/null
  done
}

FIXTURE_BASE=""

# 选一个与 electron 二进制**同一文件系统**的目录来放 fixture。
#
# 必须同设备：fixture 的 app-bin 是 electron 二进制的硬链接（200MB，零拷贝且
# 共享 page cache，正是真实场景）。跨设备硬链接会失败，回退成 cp 两份 200MB。
# 本机 /tmp 是 tmpfs 且有配额，cp 直接 "超出磁盘配额"——fixture 建不出来，
# 测试就报「未接入」，看起来像功能坏了。
pick_fixture_base() {
  local bin=$1 bindev d
  bindev=$(stat -c '%d' "$bin" 2>/dev/null) || { echo /tmp; return; }
  for d in /tmp /var/tmp "${XDG_CACHE_HOME:-$HOME/.cache}" "$HOME"; do
    [[ -d $d && -w $d ]] || continue
    [[ "$(stat -c '%d' "$d" 2>/dev/null)" == "$bindev" ]] && { echo "$d"; return; }
  done
  echo /tmp
}

cleanup() {
  kill_matching "chromius-host="
  kill_matching "out/daemon/main.js"
  kill_matching "chromius-e2e-fixture"
  rm -rf "${FIXTURE_BASE:-/tmp}"/chromius-e2e-fixture1 "${FIXTURE_BASE:-/tmp}"/chromius-e2e-fixture2
}
trap cleanup EXIT

setup_fixture() {
  local n=$1
  local dir=$FIXTURE_BASE/chromius-e2e-fixture$n
  rm -rf "$dir"; mkdir -p "$dir/resources/app/dist"
  # 硬链接同一份 ELF：不复制 200MB，且共享 page cache（正是真实场景）
  ln /usr/lib/electron41/electron "$dir/app-bin" 2>/dev/null || cp /usr/lib/electron41/electron "$dir/app-bin"
  echo "{\"name\":\"e2e-fixture$n\",\"version\":\"1.0.0\",\"main\":\"dist/main.js\"}" > "$dir/resources/app/package.json"
  cat > "$dir/resources/app/dist/main.js" <<'JS'
const { app, BrowserWindow } = require('electron');
console.log('NAME=' + app.getName());
console.log('USERDATA=' + app.getPath('userData'));
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 500, height: 400, show: false });
  w.loadURL('data:text/html,<h1>fixture</h1>');
  console.log('READY');
});
JS
}

echo "== 准备 =="
[[ -x out/chromius-shim ]] || { echo "shim 未编译：npm run build"; exit 1; }
FIXTURE_BASE=$(pick_fixture_base /usr/lib/electron41/electron)
echo "  fixture 目录: $FIXTURE_BASE（与 electron 二进制同设备，可硬链接）"
cleanup; sleep 0.5
setsid node out/daemon/main.js > /tmp/chromius-e2e-daemon.log 2>&1 < /dev/null &
sleep 1.5
[[ -S "${XDG_RUNTIME_DIR:-/tmp}/chromius/broker.sock" ]] && ok "daemon socket 就绪" || bad "daemon 未就绪"
setup_fixture 1
setup_fixture 2

echo "== 接入 fixture1 =="
OUT1=$(timeout 40 node out/cli/index.js launch "$FIXTURE_BASE/chromius-e2e-fixture1/app-bin" 2>/dev/null)
echo "$OUT1" | grep -q "attached" && ok "fixture1 attached" || bad "fixture1 未接入: $OUT1"
sleep 1

HOST_PID=$(pgrep -f "chromius-host=41" | head -1)
if [[ -n "${HOST_PID:-}" ]]; then
  N=$(pgrep -f "chromius-host=41" | wc -l)
  [[ "$N" -eq 1 ]] && ok "唯一宿主进程 (pid=$HOST_PID)" || bad "宿主进程数=$N"
  PSS1=$(./test/measure-pss.sh "$HOST_PID" | tail -1 | grep -oE '[0-9]+ MB')
  ok "1 个子应用 PSS=$PSS1"
else
  bad "找不到宿主进程"
  HOST_PID=""
fi

echo "== 接入 fixture2（同一宿主）=="
OUT2=$(timeout 40 node out/cli/index.js launch "$FIXTURE_BASE/chromius-e2e-fixture2/app-bin" 2>/dev/null)
echo "$OUT2" | grep -q "attached" && ok "fixture2 attached" || bad "fixture2 未接入: $OUT2"
sleep 1
if [[ -n "$HOST_PID" ]]; then
  HOST_PID2=$(pgrep -f "chromius-host=41" | head -1)
  [[ "$HOST_PID2" == "$HOST_PID" ]] && ok "复用同一个宿主 (pid 未变)" || bad "宿主被重新拉起"
  N2=$(pgrep -f "chromius-host=41" | wc -l)
  [[ "$N2" -eq 1 ]] && ok "仍然只有一个宿主进程" || bad "宿主进程数=$N2"
  PSS2=$(./test/measure-pss.sh "$HOST_PID" | tail -1 | grep -oE '[0-9]+ MB')
  ok "2 个子应用 PSS=$PSS2"
fi

echo "== status =="
ST=$(timeout 5 node out/cli/index.js status 2>/dev/null)
echo "$ST" | grep -q "e2e-fixture2" && ok "status 列出两个子应用" || bad "status 缺少子应用"

echo
echo "==== 结果: $PASS 通过, $FAIL 失败 ===="
[[ $FAIL -eq 0 ]]
