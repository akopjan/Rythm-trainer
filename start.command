#!/bin/zsh
cd "${0:A:h}" || exit 1
python3 - <<'PY'
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import webbrowser

url = 'http://localhost:8000/'
try:
    server = ThreadingHTTPServer(('127.0.0.1', 8000), SimpleHTTPRequestHandler)
except OSError as error:
    raise SystemExit(f'Не удалось запустить тренажёр на порту 8000: {error}')
print(f'Тренажёр: {url}\nНастройки сохраняются в cookies. Для остановки нажмите Ctrl+C.', flush=True)
webbrowser.open(url)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
PY
