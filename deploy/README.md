# Scheduling on macOS (launchd)

Runs one Gmail poll a day. If a new Verizon bill has arrived you get an email
saying so; then you run the browser step yourself. Nothing runs between checks.

## Install

```bash
npm run build              # launchd runs dist/, not tsx
npm run schedule:install   # generates the plist for this machine and loads it
```

The plist needs absolute paths (launchd does not read your shell profile), and
those differ per machine — so it is generated from `launchd.plist.template`
rather than committed. Re-run `npm run schedule:install` after moving the
project or changing Node versions.

Default is 09:00 daily. To change it:

```bash
SCHEDULE_HOUR=7 npm run schedule:install
```

## Verify

```bash
launchctl start com.personal-automation.verizon   # run now, don't wait
tail -f data/launchd.log

launchctl list | grep personal-automation         # PID  last-exit-code  label
```

The middle column is the last exit status: `0` is success, anything else means
the run failed and the log will say why.

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.personal-automation.verizon.plist
rm ~/Library/LaunchAgents/com.personal-automation.verizon.plist
```

## Notes

- **Asleep at the scheduled time?** launchd runs a missed
  `StartCalendarInterval` job when the machine next wakes. A closed laptop
  delays the check; it does not skip it.
- **One notification per bill.** A bill needing a human is never re-notified,
  so a daily job will not nag you.
- **It never opens a browser.** The scheduled run only detects and notifies;
  starting the browser step is always yours.
- **Log growth** is negligible, but `data/launchd.log` is not rotated.
