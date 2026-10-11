# End-to-end checks (jsdom)

Runs the real `public/sdk.js` and the real dashboard scripts inside jsdom against a running server. Use a throw-away database,
never your real one -- the scripts register an account and create data.

    # terminal 1 (PowerShell)
    $env:DATA_DB_PATH = "$env:TEMP\optimize-e2e.db"; .venv\Scripts\python -m uvicorn backend.main:app --port 8011
    # terminal 2
    cd tests\e2e; npm install; node sdk.e2e.js; node dashboard.e2e.js     # dashboard.e2e.js needs the data sdk.e2e.js creates

`BASE=http://host:port` points them at another server. Python tests (stats, API) live one folder up: `python -m pytest tests`.
