#!/usr/bin/env python3
"""
从 dodo 侧同步面试官日历空闲时段到预约系统
使用 calendar-meeting skill 查询忙闲，生成可用时段 JSON

用法（在 dodo 沙箱中运行）：
    python3 sync_calendar.py --position pos_1 --date 2026-07-22
"""
import json
import subprocess
import sys
from datetime import datetime

DATA_DIR = "../data"
POSITIONS_FILE = f"{DATA_DIR}/positions.json"

def get_freebusy(email, date):
    """调用 calendar-meeting 查询面试官忙闲"""
    cmd = [
        "python3", "-m", "scripts.calendar_client",
        "freebusy", "--email", email, "--date", date
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd="/home/gem/workspace/.claude/skills/calendar-meeting")
    if result.returncode != 0:
        print(f"  ⚠️  查询 {email} 失败: {result.stderr}")
        return None
    return json.loads(result.stdout)

def calc_free_slots(busy_periods, date, windows, duration_min=60):
    """
    根据 busy periods 计算空闲时段
    windows: [(10,12), (14,18), (19,20)]
    """
    free_slots = []
    for ws, we in windows:
        current = ws * 60
        end = we * 60
        while current + duration_min <= end:
            slot_start = current
            slot_end = current + duration_min

            # 检查是否与 busy 重叠
            conflict = False
            for bs, be in busy_periods:
                if not (slot_end <= bs or slot_start >= be):
                    conflict = True
                    break

            if not conflict:
                h1, m1 = divmod(slot_start, 60)
                h2, m2 = divmod(slot_end, 60)
                free_slots.append({
                    "date": None,  # 由命令行参数传入
                    "start": f"{h1:02d}:{m1:02d}",
                    "end": f"{h2:02d}:{m2:02d}",
                    "duration": duration_min
                })

            current += duration_min

    return free_slots

def main():
    import argparse
    parser = argparse.ArgumentParser(description="同步面试官日历到预约系统")
    parser.add_argument("--position", required=True, help="岗位 ID")
    parser.add_argument("--date", required=True, help="日期 YYYY-MM-DD")
    parser.add_argument("--duration", type=int, default=60, help="面试时长（分钟）")
    args = parser.parse_args()

    # 1. 读取岗位配置
    with open(POSITIONS_FILE) as f:
        data = json.load(f)

    pos = next((p for p in data["positions"] if p["id"] == args.position), None)
    if not pos:
        print(f"❌ 未找到岗位: {args.position}")
        return

    windows_map = {"morning": (10, 12), "afternoon": (14, 18), "evening": (19, 20)}
    configured_windows = [(10, 12), (14, 18), (19, 20)]

    for iv in pos["interviewers"]:
        print(f"📅 查询 {iv['name']} ({iv['email']}) 的 {args.date} 忙闲...")

        # 此处为 dodo calendar-meeting 调用
        # busy = get_freebusy(iv["email"], args.date)
        # 生产环境启用上面这行，下面用模拟数据代替
        print(f"  ⚠️  需要 dodo 环境才能查询日历，请先在 dodo 中运行 calendar-meeting")
        print(f"  → 然后手动在管理后台生成时段")

        # 生成时段逻辑示例
        duration = args.duration
        for ws, we in configured_windows:
            current = ws * 60
            end = we * 60
            while current + duration <= end:
                h1, m1 = divmod(current, 60)
                h2, m2 = divmod(current + duration, 60)
                slot = {
                    "id": f"{iv['id']}_{args.date.replace('-','')}_{h1:02d}{m1:02d}",
                    "interviewerId": iv["id"],
                    "interviewerLabel": iv["label"],
                    "date": args.date,
                    "start": f"{h1:02d}:{m1:02d}",
                    "end": f"{h2:02d}:{m2:02d}",
                    "status": "available",
                    "candidateName": None
                }
                print(f"  📌 {slot['date']} {slot['start']}-{slot['end']} ({iv['label']})")
                current += duration

if __name__ == "__main__":
    main()