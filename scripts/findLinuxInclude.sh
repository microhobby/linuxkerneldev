#!/bin/bash

echo "Searching 🏃 (Embedded Linux Dev)"

# find
FILE=$1/include/$2
if [ -f "$FILE" ]; then
	echo "Opening 📜 (Embedded Linux Dev)"
	eval "$3 $FILE"
else
	echo "Not found $FILE 😢 (Embedded Linux Dev)" 1>&2
	exit 42
fi

echo "Done 😎 (Embedded Linux Dev)"
