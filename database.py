"""
database.py
------------
Sab chat history yahan SQLite database (data/chats.db) me store hoti hai.
Har message ke saath: session id (user ka phone/number), sender (user/bot),
message text, timestamp, aur escalated flag (agar user ne human/management maanga ho).
"""

import sqlite3
import os
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), "data", "chats.db")


def get_connection():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_connection()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            sender TEXT NOT NULL,          -- 'user' or 'bot'
            message TEXT NOT NULL,
            escalated INTEGER DEFAULT 0,   -- 1 if this message triggered human handoff
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            status TEXT DEFAULT 'bot',     -- 'bot' or 'escalated' (human needed)
            last_active TEXT NOT NULL
        )
        """
    )
    conn.commit()
    conn.close()


def save_message(session_id: str, sender: str, message: str, escalated: bool = False):
    conn = get_connection()
    now = datetime.utcnow().isoformat()
    conn.execute(
        "INSERT INTO messages (session_id, sender, message, escalated, created_at) VALUES (?, ?, ?, ?, ?)",
        (session_id, sender, message, int(escalated), now),
    )
    # upsert session status
    status = "escalated" if escalated else None
    existing = conn.execute("SELECT * FROM sessions WHERE session_id=?", (session_id,)).fetchone()
    if existing:
        new_status = status if status else existing["status"]
        conn.execute(
            "UPDATE sessions SET status=?, last_active=? WHERE session_id=?",
            (new_status, now, session_id),
        )
    else:
        conn.execute(
            "INSERT INTO sessions (session_id, status, last_active) VALUES (?, ?, ?)",
            (session_id, status or "bot", now),
        )
    conn.commit()
    conn.close()


def get_history(session_id: str, limit: int = 20):
    conn = get_connection()
    rows = conn.execute(
        "SELECT sender, message, created_at FROM messages WHERE session_id=? ORDER BY id ASC LIMIT ?",
        (session_id, limit),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_all_sessions():
    conn = get_connection()
    rows = conn.execute("SELECT * FROM sessions ORDER BY last_active DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_all_messages_for_session(session_id: str):
    conn = get_connection()
    rows = conn.execute(
        "SELECT * FROM messages WHERE session_id=? ORDER BY id ASC", (session_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def mark_resolved(session_id: str):
    conn = get_connection()
    conn.execute("UPDATE sessions SET status='bot' WHERE session_id=?", (session_id,))
    conn.commit()
    conn.close()
