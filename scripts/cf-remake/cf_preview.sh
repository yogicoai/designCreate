#!/usr/bin/env bash
# 레퍼런스(요기보 팟 33초) 위에 우리 컷을 원래 자리에 끼워 넣은 미리보기. 음원은 회사 원본 그대로.
# 사용: bash cf_preview.sh <팟카드.mp4> <G컷_글자.mp4> <휴식카드.mp4> <출력.mp4>
set -e
cd "$(dirname "$0")"
POT="$1"; G="$2"; REST="$3"; OUT="$4"
ffmpeg -y -loglevel error -i ref_pod33.mp4 -i "$POT" -i "$G" -i "$REST" -filter_complex "\
[0:v]trim=0:5.589,setpts=PTS-STARTPTS,fps=24000/1001,scale=1920:1080,setsar=1[r1];\
[1:v]fps=24000/1001,scale=1920:1080,setsar=1,setpts=PTS-STARTPTS[p];\
[0:v]trim=7.966:26.693,setpts=PTS-STARTPTS,fps=24000/1001,scale=1920:1080,setsar=1[r2];\
[2:v]fps=24000/1001,scale=1920:1080,setsar=1,setpts=PTS-STARTPTS[g];\
[3:v]fps=24000/1001,scale=1920:1080,setsar=1,setpts=PTS-STARTPTS[c];\
[0:v]trim=29.905:33.033,setpts=PTS-STARTPTS,fps=24000/1001,scale=1920:1080,setsar=1[r3];\
[r1][p][r2][g][c][r3]concat=n=6:v=1:a=0[v]" \
  -map "[v]" -map 0:a -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart -shortest "$OUT"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT"
