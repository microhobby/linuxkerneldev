#!/usr/bin/pwsh-preview -NoProfile 

docker run --rm -v ${pwd}:${pwd} seadoglinux/ctags --help
