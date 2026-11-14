#!/bin/bash
# 测量某个进程及其所有子孙的 PSS 总和（KB）。
# PSS 对共享页按比例折算，是"真实占用"的正确指标。
# 用法: ./measure-pss.sh <pid>
set -u

root=${1:?usage: measure-pss.sh <pid>}

gettree() {
  local p=$1
  echo "$p"
  for c in $(pgrep -P "$p" 2>/dev/null); do
    gettree "$c"
  done
}

total=0
count=0
for p in $(gettree "$root"); do
  pss=$(awk '/^Pss:/{s+=$2} END{print s+0}' "/proc/$p/smaps_rollup" 2>/dev/null || echo 0)
  comm=$(cat "/proc/$p/comm" 2>/dev/null || echo '?')
  if [ "${pss:-0}" -gt 0 ]; then
    printf "  pid=%-8s comm=%-20s pss=%6d KB\n" "$p" "$comm" "$pss"
    total=$((total + pss))
    count=$((count + 1))
  fi
done
echo "TOTAL: ${count} processes, $((total / 1024)) MB PSS"
