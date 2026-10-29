# Telegram post scripts

Server-side, standard-library Python 3 plus curl. They read the bot token from the root env file
(`/etc/lemniscate-release/release.env`, or `RELEASE_ENV`), pass it to curl through a config on stdin and never print it.
`--dry-run` prints what would be sent and touches neither the token nor the network.

- `post-schedule.py`: the launch schedule from the server's `schedule.json` (UTC plus the owner's zone, DST aware), split
  under 3,800 characters. `--new TU33,TU34` marks new items, `--save ~/schedule.txt` keeps a copy.
- `post-poster.py`: `sendPhoto` / `sendMediaGroup` with captions of 1,024 characters or less; the full text follows as a normal
  message. `--update N` reads `marketing/posters/update-NN.png` and `marketing/posts/all-posts-in-release-order.txt`.

The marketing kit lives in `docs/tech-updates/live-launch/marketing/` (posters, posts); the runner in `docs/tech-updates/live-launch/release/`.
Tests: `bun test scripts/telegram` (a fake Telegram receiver on a random local port).
