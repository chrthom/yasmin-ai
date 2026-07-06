#!/bin/bash
cd /home/christopher/Dokumente/yasmin-ai
export NODE_ENV=production
node dist/nightly/run.js >> /var/log/yasmin-nightly.log 2>&1
code=$?
[ $code -ne 0 ] && echo "Yasmin nightly FAILED ($code)" | mail -s "Yasmin Alert" christopher.thomsen@adesso.de
