#!/usr/bin/env python3
"""Post the launch schedule to Telegram, generated from the SERVER's release schedule (never from the plan).

  post-schedule.py [--schedule schedule.json] [--zone America/Toronto] [--chat community|ops] [--new TU33,TU34]
                   [--save ~/schedule.txt] [--dry-run]

One line per update: `HH:MM UTC (HH:MM EDT): Update N, <title>`, grouped by day, new items marked (NEW). The zone follows
DST (US clocks change on the first Sunday of November). Messages are cut at day boundaries under 3,800 characters
(Telegram's limit is 4,096). The token is read from the root env file and goes to curl on stdin; it is never printed.
Slots come from the schedule file's per-update `slot` (written by release.py set-times) or, when absent, from `launchAt`
plus the cadence. Marketing kit: docs/tech-updates/live-launch/marketing/ (posts, posters); the runner:
docs/tech-updates/live-launch/release/.
"""
import argparse, json, os, sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tg

FOOTER = "Each update goes live only after its checks pass. One that fails is held, never released broken."


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def slots(schedule):
    """[(update, utc datetime)] in release order."""
    out = []
    launch = schedule.get("launchAt")
    step = float(schedule.get("cadence", {}).get("intervalMinutes", 120))
    for k, update in enumerate(schedule["updates"]):
        if update.get("slot"):
            when = parse_time(update["slot"])
        elif launch:
            when = parse_time(launch) + timedelta(minutes=k * step)
        else:
            tg.die("the schedule has no slot times and no launchAt: the launch time is not set yet")
        out.append((update, when))
    return out


def day_blocks(schedule, zone, new_ids):
    tz = ZoneInfo(zone)
    days = {}
    for update, when in slots(schedule):
        local = when.astimezone(tz)
        line = f"{when:%H:%M} UTC ({local:%H:%M} {local.tzname()}): Update {update['n']}, {update['title']}"
        if update["id"] in new_ids:
            line += " (NEW)"
        days.setdefault(update.get("day") or 1, []).append((when, local, line))
    blocks = []
    for day in sorted(days):
        first = days[day][0][1]
        blocks.append(f"Day {day} ({first:%A %B} {first.day})\n" + "\n".join(line for _, _, line in days[day]))
    return blocks


def messages(blocks, limit=tg.TEXT_LIMIT):
    """Pack whole day blocks into messages under the limit; a day longer than the limit is split by lines. The footer is
    reserved room in the last message."""
    packed, current = [], ""
    for block in blocks + [FOOTER]:
        for part in tg.split_text(block, limit):
            if current and len(current) + 2 + len(part) > limit:
                packed.append(current)
                current = ""
            current = f"{current}\n\n{part}" if current else part
    if current:
        packed.append(current)
    return packed


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--schedule", default=os.environ.get("SCHEDULE_FILE", "schedule.json"))
    ap.add_argument("--zone", default="America/Toronto")
    ap.add_argument("--chat", default="community", choices=sorted(tg.CHAT_KEYS))
    ap.add_argument("--new", default="", help="comma separated update ids to mark (NEW)")
    ap.add_argument("--save", help="also write the text to this file (the owner's home folder)")
    ap.add_argument("--env-file")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    try:
        schedule = json.load(open(args.schedule, encoding="utf-8"))
    except (OSError, ValueError) as error:
        tg.die(f"cannot read the schedule {args.schedule}: {error}")
    try:
        ZoneInfo(args.zone)
    except Exception:
        tg.die(f"unknown time zone {args.zone}")
    texts = messages(day_blocks(schedule, args.zone, {x.strip() for x in args.new.split(",") if x.strip()}))
    if args.save:
        with open(args.save, "w", encoding="utf-8") as handle:
            handle.write("\n\n".join(texts) + "\n")
    sender = tg.Sender(args.chat, tg.env_file_arg(args.env_file), args.dry_run)
    for text in texts:
        sender.message(text)
    print(f"post-schedule: {len(texts)} message(s) {'prepared (dry run)' if args.dry_run else 'sent'} to {args.chat}")


if __name__ == "__main__":
    main()
