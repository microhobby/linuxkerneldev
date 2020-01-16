#!/bin/bash

echo "Searching 🏃 (Embedded Linux Dev)"

# find
FILE=$(find $1/arch/arm64/boot/dts/ -name "$2")

if [ -f "$FILE" ]; then
	echo "Opening 📜 (Embedded Linux Dev)"
	code $FILE
else
	echo "Not found $2 😢 (Embedded Linux Dev)" 1>&2
	exit 42
fi

echo "Done 😎 (Embedded Linux Dev)"
