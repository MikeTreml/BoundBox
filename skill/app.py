"""Streamlit operator shell for the BoundBox drawing canvas."""

from __future__ import annotations

import html
import json
import os
import socket
from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components


TOWER_CONFIG = Path(os.environ.get("BOUNDBOX_TOWER_CONFIG", r"C:\Dashboard\DashboardHub\data\dashboards.json"))


def tower_navigation() -> None:
    try:
        apps = [row for row in json.loads(TOWER_CONFIG.read_text(encoding="utf-8")) if row.get("enabled") and row.get("public_url")]
    except (OSError, json.JSONDecodeError):
        return
    if not apps:
        return
    labels = [row["name"] for row in apps]
    index = labels.index("BoundBox") if "BoundBox" in labels else 0
    choice = st.sidebar.selectbox("Tower tools", labels, index=index)
    selected = apps[labels.index(choice)]
    url = html.escape(selected["public_url"].replace("{host}", socket.gethostname()), quote=True)
    st.sidebar.markdown(f'<a href="{url}" target="_self" style="display:block;text-align:center;padding:.45rem .75rem;border:1px solid #d0d5dd;border-radius:8px;text-decoration:none;color:inherit">Open selected tool</a>', unsafe_allow_html=True)


st.set_page_config(page_title="BoundBox", page_icon="\U0001f532", layout="wide", initial_sidebar_state="collapsed")
st.markdown(
    """
    <style>
    [data-testid="stHeader"] { height: 0; }
    [data-testid="stAppViewContainer"] { height: 100vh; }
    [data-testid="stMain"] { height: 100vh; }
    [data-testid="stMainBlockContainer"] {
      padding: 0 !important;
      max-width: none !important;
      height: 100vh;
    }
    [data-testid="stVerticalBlock"]:has(iframe) { height: 100%; }
    iframe[title="st.iframe"] { height: 100vh !important; }
    </style>
    """,
    unsafe_allow_html=True,
)
tower_navigation()

api_port = os.environ.get("BOUNDBOX_API_PORT")
token = os.environ.get("BOUNDBOX_TOKEN")
exchange_dir = os.environ.get("BOUNDBOX_EXCHANGE_DIR", "")
idle_seconds = int(os.environ.get("BOUNDBOX_IDLE_SECONDS", "0"))
if not api_port or not token:
    st.error("BoundBox was opened without its exchange service. Start it with `python launch.py --dir <project>/boundbox`.")
    st.stop()

st.sidebar.caption(f"Exchange: {exchange_dir}")
st.sidebar.caption(f"On-demand: stops after {idle_seconds // 60} minutes of browser inactivity." if idle_seconds else "Tower service: continuous until stopped from Tower.")
wrapper = f"""
<!doctype html><html><head><style>html,body,iframe{{width:100%;height:100%;margin:0;border:0;overflow:hidden;background:#f6f5f2}}</style></head>
<body><iframe id="boundbox" title="BoundBox drawing canvas" allow="clipboard-read; clipboard-write"></iframe>
<script>
const referrer = new URL(document.referrer || window.location.href);
const host = referrer.hostname || '127.0.0.1';
document.getElementById('boundbox').src = `${{referrer.protocol}}//${{host}}:{int(api_port)}/{token}/`;
</script></body></html>
"""
components.html(wrapper, height=1200, scrolling=False)
