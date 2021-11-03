#!/bin/bash

# find
grep -rs $2 $1/Documentation/devicetree/bindings/
#fileList=(${grepRet//:/ })
#fileList=$grepRet

#echo $grepRet
