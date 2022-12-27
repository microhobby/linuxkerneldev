#!/bin/bash

sshpass \
    -p "$1" \
    ssh \
    -o UserKnownHostsFile=/dev/null \
    -o StrictHostKeyChecking=no \
    "$2@$3" \
    "echo \"$1\" | sudo -S bash -c \"echo g > /proc/sysrq-trigger 2> breakErr.log &\""
