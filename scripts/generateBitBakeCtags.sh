#!/bin/bash

echo "BitBake Indexer 🏃 (Embedded Linux Dev)"

# generate ctags for BitBake language
# ctags \
# 	--langdef=BitBake \
# 	--langmap=BitBake:.bb.bbappend.inc.bbclass.conf \
# 	'--regex-BitBake=/^[[:space:]]*(define|inherit|require|export|addtask|addhandler|python|do_[[:alnum:]_]+[ \t]+[\{|\(]?)/\1/d,definition/' \
# 	'--regex-BitBake=/^[ \t]*(export|inherit)[ \t]+([a-zA-Z0-9_-]+)/\2/f,function/' \
# 	'--regex-BitBake=/^[ \t]*([a-zA-Z0-9_-]+)[ \t]+?=[ \t]+/\1/v,variable/' \
# 	'--regex-BitBake=/^[ \t]*[a-zA-Z0-9_-]+[ \t]*\+?=[ \t]*\"[^\"]*/\0/v,variable/' \
# 	--recurse=yes \
# 	--languages=BitBake \
# 	-f $1/.vscode-ctags \
# 	$1

ctags \
	--langdef=BitBake \
	--langmap=BitBake:.bb.bbappend.inc.bbclass.conf \
	'--regex-BitBake=/^[ \t]*(export|inherit)[ \t]+([a-zA-Z0-9_-]+)/\2/f,function/' \
	'--regex-BitBake=/^[ \t]*([a-zA-Z0-9_-]+)[ \t]+?=[ \t]+/\1/v,variable/' \
	'--regex-BitBake=/^[ \t]*[a-zA-Z0-9_-]+[ \t]*\+?=[ \t]*\"[^\"]*/\0/v,variable/' \
	--recurse=yes \
	--languages=BitBake \
	-f $1/.vscode-ctags \
	$1 2> /dev/null

echo "Done 😎 (Embedded Linux Dev)"
