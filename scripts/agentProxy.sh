#!/bin/bash

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

killall agent-proxy

$SCRIPT_DIR/bin/agent-proxy $1^$2 localhost /dev/$3,$4
