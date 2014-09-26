#!/bin/bash

# Make sure we only auto-start the fan-control just once
PIDS=`ps aux | grep fan-control.js | grep -v grep`
if [ -z "$PIDS" ]; then
	if [[ "$1" == "prompt" ]]; then
		# prompt to bypass fan-control startup (with auto timeout)
		read -s -n 1 -p "Press n to cancel start of fan-control.js" -t 3 ANSWER
	fi
	echo
	if [[ $ANSWER != [nN] ]]; then
		echo "starting initial fan-control.js ..."
		cd /home/pi
		forever -a --minUptime=3000 --spinSleepTime=1000 --killSignal=SIGTERM -l  /home/pi/logs/fan-control.log -e /home/pi/logs/fan-control.err --sourceDir=/home/pi start fan-control.js
	else
		echo "skipping fan-control.js"
	fi
else
    echo "fan-control.js already running"

fi