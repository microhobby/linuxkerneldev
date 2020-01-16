#!/bin/bash

command -v ctags >/dev/null 2>&1 || { echo >&2 "(Embedded Linux Dev) Please Install Universal Ctags first!"; exit 1; }
echo "(Embedded Linux Dev) ctags ok"
