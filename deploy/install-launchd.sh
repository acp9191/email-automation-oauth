#!/usr/bin/env bash
# Generates and installs the launchd agent for this checkout.
#
# The plist needs absolute paths, which differ per machine, so it is generated
# here rather than committed. Re-run after moving the project or changing Node.
set -euo pipefail

LABEL="com.personal-automation.verizon"
HOUR="${SCHEDULE_HOUR:-9}"

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST="${PLIST_DIR}/${LABEL}.plist"

if [[ ! -f "${PROJECT_DIR}/dist/index.js" ]]; then
  echo "dist/ is missing — run: npm run build" >&2
  exit 1
fi

mkdir -p "${PLIST_DIR}"

sed -e "s|__LABEL__|${LABEL}|g" \
    -e "s|__NODE_BIN__|${NODE_BIN}|g" \
    -e "s|__PROJECT_DIR__|${PROJECT_DIR}|g" \
    -e "s|__HOUR__|${HOUR}|g" \
    "${PROJECT_DIR}/deploy/launchd.plist.template" > "${PLIST}"

plutil -lint "${PLIST}" >/dev/null

# Reload if it was already installed.
launchctl unload "${PLIST}" 2>/dev/null || true
launchctl load "${PLIST}"

echo "Installed ${LABEL}"
echo "  node:     ${NODE_BIN}"
echo "  project:  ${PROJECT_DIR}"
echo "  schedule: daily at ${HOUR}:00"
echo
echo "Run it now:  launchctl start ${LABEL}"
echo "Watch logs:  tail -f ${PROJECT_DIR}/data/launchd.log"
echo "Uninstall:   launchctl unload ${PLIST} && rm ${PLIST}"
