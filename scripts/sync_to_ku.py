#!/usr/bin/env python3
"""
面试预约系统 → Ku 数据表 同步脚本
将预约数据回写到【候选人信息跟进】数据表

用法: python3 sync_to_ku.py [--date YYYY-MM-DD]
"""
import json
import subprocess
import sys
from datetime import datetime

# Ku 数据表配置
CANDIDATE_TABLE_URL = "https://ku.baidu-int.com/knowledge/HFVrC7hq1Q/pKzJfZczuc/naMa5ttBrh/wYAh0CZk5u7Juj?tb=dst1QFNyuRaAZlevJ1_viw8mnimCAQur&type=dst"
KU_BIN = "/home/gem/workspace/.claude/skills/ku-doc-manage/bin/ku"

def load_bookings(path="../data/bookings.json"):
    with open(path) as f:
        data = json.load(f)
    return data["bookings"]

def push_to_ku(booking):
    """将一条预约记录写入 Ku 数据表"""
    record = {
        "候选人姓名": booking["candidateName"],
        "候选人邮箱": "",   # 预约时没有收集邮箱，可后续补充
        "岗位": booking["positionName"],
        "面试进程": "一面",  # 根据岗位名称可推导，暂时默认
        "面试官": booking["interviewerName"],
        "安排时间": datetime.now().strftime("%-m.%-d"),
        "是否待回复": "待回复",
    }

    cmd = [
        KU_BIN, "create", "--datasheet-url", CANDIDATE_TABLE_URL,
        "--record", json.dumps(record),
        "--format", "json"
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0:
        print(f"  ✅ {booking['candidateName']} -> 写入成功")
    else:
        print(f"  ❌ {booking['candidateName']} -> 写入失败: {result.stderr.strip()}")

def main():
    date_filter = sys.argv[1] if len(sys.argv) > 1 else None
    bookings = load_bookings()

    if not bookings:
        print("📭 暂无待同步的预约记录")
        return

    # 可选按日期过滤
    if date_filter:
        bookings = [b for b in bookings if b.get("slotDate", "").startswith(date_filter)]

    print(f"📤 同步 {len(bookings)} 条预约记录到 Ku 数据表...")
    for b in bookings:
        if "已同步" not in b.get("tags", []):
            push_to_ku(b)

if __name__ == "__main__":
    main()