#!/bin/bash

# find
grepRet=$(grep -nrs --include=\*.c $2 $1/drivers/)
#fileList=(${grepRet//:/ })
fileList=$grepRet

echo $fileList
