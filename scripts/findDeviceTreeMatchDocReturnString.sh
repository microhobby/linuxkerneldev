#!/bin/bash

# find
grepRet=$(grep -rs $2 $1/Documentation/devicetree/bindings/)

echo $grepRet
