# BoundBox

BoundBox is a Python/Streamlit visual workspace for drawing labeled layout boxes on a blank canvas or marking changes over a Wireloom wireframe. The browser canvas exports structured JSON for an AI while the Python exchange service provides atomic persistence and append-only recovery history.

## Run with Tower

```powershell
python launch.py --dir C:\Dashboard\BoundBox\data\exchange
```

The Streamlit operator shell binds to `0.0.0.0:8620`; its token-protected Python canvas API binds to `0.0.0.0:8621`. The stable service remains running until Tower or the console stops it.

## Run on demand

```powershell
python launch.py --dir C:\path\to\project\boundbox --on-demand
```

The page heartbeat keeps an active workspace alive. After the browser closes, the Python launcher stops both services following 30 minutes of inactivity. Override that interval with `--idle-seconds`.

Install the runtime dependency with `python -m pip install -r requirements.txt`. Node is not part of the executable server or launcher; it is used only to maintain the self-contained browser canvas bundle.

## Exchange history

```powershell
python history.py list --dir C:\path\to\project\boundbox
python history.py show 12 --dir C:\path\to\project\boundbox
python history.py restore 12 --dir C:\path\to\project\boundbox
```

The exchange contract remains `source.wireloom`, `boxes.json`, `packet.json`, `project.json`, and `history/journal.jsonl`.
