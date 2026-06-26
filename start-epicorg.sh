#!/bin/bash
cd /mnt/DriveD/Nextcloud/epicorg || { echo "Could not find /mnt/DriveD/Nextcloud/epicorg"; read -p "Press Enter to close..."; exit 1; }

./epicorg /mnt/DriveD/Nextcloud/Org -file 00-Welcome.org
status=$?

if [ $status -ne 0 ]; then
  echo "epicorg exited with an error (status $status)."
  read -p "Press Enter to close..."
fi
