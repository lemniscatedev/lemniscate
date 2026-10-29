#!/usr/bin/env python3
"""Post posters to Telegram with sendPhoto (one image) or sendMediaGroup (2 to 10 images, caption on the first).

  post-poster.py --update 5 [--posters DIR] [--posts FILE] [--chat community|ops] [--dry-run]
  post-poster.py --image a.png [--image b.png ...] --caption "short caption" [--text-file full.txt] [--dry-run]

Captions stop at 1,024 characters: a short caption goes with the images and the full text follows as a normal message
(split under 3,800 characters). With --update N the poster is marketing/posters/update-NN.png, the caption is
"Update N: <title>" and the follow-up is that update's [Telegram / Discord] text from marketing/posts/
all-posts-in-release-order.txt, so post each update only AFTER it is live. The token is read from the root env file and
goes to curl on stdin; it is never printed. Marketing kit: docs/tech-updates/live-launch/marketing/.
"""
import argparse, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tg

DEFAULT_MARKETING = os.environ.get("MARKETING_DIR", "docs/tech-updates/live-launch/marketing")


def update_entry(posts_file, number):
    """(title, Telegram text) of `UPDATE NN` in the posts file."""
    try:
        text = open(posts_file, encoding="utf-8").read()
    except OSError as error:
        tg.die(f"cannot read {posts_file}: {error.strerror}")
    parts = re.split(r"^={20,}\n", text, flags=re.M)
    for part in parts:
        lines = part.strip().splitlines()
        match = lines and tg.UPDATE_HEADER.match(lines[0])
        if match and int(match.group(1)) == number:
            body = re.search(r"\[Telegram / Discord\]\n(.*?)(?:\n\[X\]|\Z)", part, flags=re.S)
            if not body:
                tg.die(f"update {number} has no [Telegram / Discord] text in {posts_file}")
            return match.group(2).strip(), body.group(1).strip()
    tg.die(f"update {number} not found in {posts_file}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--update", type=int)
    ap.add_argument("--posters", default=os.path.join(DEFAULT_MARKETING, "posters"))
    ap.add_argument("--posts", default=os.path.join(DEFAULT_MARKETING, "posts", "all-posts-in-release-order.txt"))
    ap.add_argument("--image", action="append", default=[])
    ap.add_argument("--caption", default="")
    ap.add_argument("--text-file")
    ap.add_argument("--chat", default="community", choices=sorted(tg.CHAT_KEYS))
    ap.add_argument("--env-file")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    images, caption, follow = list(args.image), args.caption, ""
    if args.update is not None:
        title, follow = update_entry(args.posts, args.update)
        images = [os.path.join(args.posters, f"update-{args.update:02d}.png")] + images
        caption = caption or f"Update {args.update}: {title}"
    if args.text_file:
        follow = open(args.text_file, encoding="utf-8").read().strip()
    if not images:
        tg.die("give --update N or at least one --image")
    if len(images) > 10:
        tg.die("an album holds at most 10 images")
    for path in images:
        if not os.path.isfile(path):
            tg.die(f"image not found: {path}")
    if len(caption) > tg.CAPTION_LIMIT:
        tg.die(f"caption is {len(caption)} characters; Telegram stops at {tg.CAPTION_LIMIT}. Use a short caption and put the full text in --text-file")
    sender = tg.Sender(args.chat, tg.env_file_arg(args.env_file), args.dry_run)
    if len(images) == 1:
        sender.photo(images[0], caption)
    else:
        sender.media_group(images, caption)
    for piece in tg.split_text(follow) if follow else []:
        sender.message(piece)
    print(f"post-poster: {len(images)} image(s) {'prepared (dry run)' if args.dry_run else 'sent'} to {args.chat}")


if __name__ == "__main__":
    main()
