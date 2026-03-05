#!/bin/bash

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
ARCH=$(uname -m)

killall agent-proxy-$ARCH
# let the serial settle
sleep 1s

$SCRIPT_DIR/bin/agent-proxy-$ARCH $1^$2 localhost /dev/$3,$4
