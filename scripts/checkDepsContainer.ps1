#!/usr/bin/pwsh-preview -NoProfile 

docker run -v ${pwd}:${pwd} seadoglinux/ctags $args
