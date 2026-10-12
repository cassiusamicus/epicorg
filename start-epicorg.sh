#!/bin/bash
cd "$(dirname "$(readlink -f "$0")")" || { echo "Could not find epicorg directory"; read -p "Press Enter to close..."; exit 1; }

pkill -x epicorg 2>/dev/null
make build || { echo "Build failed"; read -p "Press Enter to close..."; exit 1; }

./epicorg /mnt/DriveD/Nextcloud/Org -file Welcome.org
status=$?

if [ $status -ne 0 ]; then
  echo "epicorg exited with an error (status $status)."
  read -p "Press Enter to close..."
fi
