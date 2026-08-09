@echo off

start /b node gotracker-proxy-local.js

timeout /t 3 /nobreak

cd /d "GO_Board"

start http://localhost:3000

npx serve .
