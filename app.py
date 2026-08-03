"""
app.py
------
Main Flask application.

Routes:
  GET  /                -> Browser-based WhatsApp-style demo chat (test WITHOUT real WhatsApp)
  POST /api/send         -> AJAX endpoint used by the demo chat UI
  POST /webhook           -> REAL WhatsApp webhook (Twilio calls this when a WhatsApp msg arrives)
  GET  /admin             -> Simple dashboard: all conversations + which ones need a human
  GET  /admin/<session_id> -> Full chat history for one user

Run:
  python app.py
  -> opens on http://127.0.0.1:5000
"""

import os
import uuid
import threading
import requests
from flask import Flask, request, render_template, jsonify, session, redirect, url_for
from dotenv import load_dotenv

load_dotenv()

import database
import ai_engine

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET", "dev-secret-change-me")

database.init_db()


# ---------------------------------------------------------------------------
# 1) BROWSER DEMO (no WhatsApp/Twilio account needed - test right now)
# ---------------------------------------------------------------------------
@app.route("/")
def demo_chat():
    if "session_id" not in session:
        session["session_id"] = "demo-" + uuid.uuid4().hex[:8]
    return render_template(
        "chat_demo.html",
        company_name=ai_engine.COMPANY_NAME,
        session_id=session["session_id"],
    )


@app.route("/api/send", methods=["POST"])
def api_send():
    data = request.get_json(force=True)
    user_message = data.get("message", "").strip()
    session_id = data.get("session_id") or session.get("session_id", "anonymous")

    if not user_message:
        return jsonify({"error": "empty message"}), 400

    reply, escalated = handle_incoming_message(session_id, user_message)
    return jsonify({"reply": reply, "escalated": escalated})


@app.route("/api/send_file", methods=["POST"])
def api_send_file():
    """
    Used by the browser demo when the user attaches a PDF/image.
    Expects multipart/form-data: file, message (caption), session_id
    """
    session_id = request.form.get("session_id") or session.get("session_id", "anonymous")
    caption = request.form.get("message", "").strip()
    uploaded = request.files.get("file")

    if not uploaded:
        return jsonify({"error": "no file"}), 400

    file_bytes = uploaded.read()
    media_type = uploaded.mimetype or "application/pdf"
    filename = uploaded.filename or "attachment"

    history = database.get_history(session_id)
    if not history:
        welcome = ai_engine.get_welcome_message()
        database.save_message(session_id, "bot", welcome)
        history = database.get_history(session_id)

    user_note = f"📎 {filename}" + (f"\n{caption}" if caption else "")
    database.save_message(session_id, "user", user_note)

    reply = ai_engine.get_document_ai_response(caption, file_bytes, media_type, history)
    database.save_message(session_id, "bot", reply)

    return jsonify({"reply": reply, "escalated": False})


# ---------------------------------------------------------------------------
# 2) REAL WHATSAPP WEBHOOK (Twilio WhatsApp Sandbox / Business API)
# ---------------------------------------------------------------------------
@app.route("/webhook", methods=["POST"])
def whatsapp_webhook():
    """
    Twilio sends form-encoded POST data here for every WhatsApp message.
    Docs: https://www.twilio.com/docs/whatsapp/api

    IMPORTANT: Twilio only waits ~15 seconds for a webhook response. If the AI
    (especially a free-tier model under load) takes longer, Twilio gives up and
    the user never receives a reply on WhatsApp - even though our server finishes
    the work and saves it to the database.

    Fix: acknowledge Twilio immediately with an empty response, then generate the
    AI reply in a background thread and send it separately via the Twilio REST API.
    """
    incoming_msg = request.values.get("Body", "").strip()
    from_number = request.values.get("From", "unknown")  # e.g. whatsapp:+91xxxxxxxxxx
    num_media = int(request.values.get("NumMedia", "0"))
    media_url = request.values.get("MediaUrl0")
    media_type = request.values.get("MediaContentType0", "application/pdf")

    thread = threading.Thread(
        target=_process_and_send_whatsapp_reply,
        args=(from_number, incoming_msg, num_media, media_url, media_type),
        daemon=True,
    )
    thread.start()

    # Respond to Twilio immediately with empty TwiML so it doesn't time out
    return ('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 200,
            {"Content-Type": "text/xml"})


def _process_and_send_whatsapp_reply(from_number, incoming_msg, num_media, media_url, media_type):
    """Runs in a background thread - generates the reply, then sends it via Twilio's API."""
    try:
        if num_media > 0:
            reply = handle_incoming_media(from_number, incoming_msg, media_url, media_type)
        else:
            reply, _escalated = handle_incoming_message(from_number, incoming_msg)
        _send_whatsapp_message(from_number, reply)
    except Exception as e:
        _send_whatsapp_message(from_number, f"⚠️ Kuch error aa gaya, please try again: {e}")


def _send_whatsapp_message(to_number: str, body: str):
    """Sends a WhatsApp message via Twilio's REST API (not the webhook TwiML response)."""
    from twilio.rest import Client

    account_sid = os.getenv("TWILIO_ACCOUNT_SID")
    auth_token = os.getenv("TWILIO_AUTH_TOKEN")
    from_whatsapp = os.getenv("TWILIO_WHATSAPP_NUMBER", "whatsapp:+14155238886")

    if not account_sid or not auth_token:
        print("Twilio credentials missing - cannot send message")
        return

    client = Client(account_sid, auth_token)
    client.messages.create(from_=from_whatsapp, to=to_number, body=body)


def handle_incoming_media(session_id: str, caption: str, media_url: str, media_type: str) -> str:
    """
    Downloads a WhatsApp attachment (PDF/image) sent via Twilio and sends it to Claude
    so the bot can read and reply about the actual document content.
    Twilio media URLs require Basic Auth with your Account SID / Auth Token.
    """
    history = database.get_history(session_id)
    if not history:
        welcome = ai_engine.get_welcome_message()
        database.save_message(session_id, "bot", welcome)
        history = database.get_history(session_id)

    database.save_message(session_id, "user", f"📎 [attachment]" + (f"\n{caption}" if caption else ""))

    try:
        account_sid = os.getenv("TWILIO_ACCOUNT_SID")
        auth_token = os.getenv("TWILIO_AUTH_TOKEN")
        resp = requests.get(media_url, auth=(account_sid, auth_token), timeout=20)
        resp.raise_for_status()
        file_bytes = resp.content
    except Exception as e:
        reply = f"⚠️ File download karne me error aaya: {e}"
        database.save_message(session_id, "bot", reply)
        return reply

    reply = ai_engine.get_document_ai_response(caption, file_bytes, media_type, history)
    database.save_message(session_id, "bot", reply)
    return reply


# ---------------------------------------------------------------------------
# Shared core logic used by BOTH the demo and the real WhatsApp webhook
# ---------------------------------------------------------------------------
def handle_incoming_message(session_id: str, user_message: str):
    history = database.get_history(session_id)

    # first message ever in this session -> send welcome message first
    if not history:
        welcome = ai_engine.get_welcome_message()
        database.save_message(session_id, "bot", welcome)
        history = database.get_history(session_id)

    database.save_message(session_id, "user", user_message)

    escalated = ai_engine.detect_escalation(user_message)
    if escalated:
        reply = ai_engine.get_escalation_reply()
    else:
        reply = ai_engine.get_ai_response(user_message, history)

    database.save_message(session_id, "bot", reply, escalated=escalated)
    return reply, escalated


# ---------------------------------------------------------------------------
# 3) ADMIN DASHBOARD - view stored chat history / escalated conversations
# ---------------------------------------------------------------------------
@app.route("/admin")
def admin_dashboard():
    sessions = database.get_all_sessions()
    return render_template("admin.html", sessions=sessions)


@app.route("/admin/<session_id>")
def admin_session(session_id):
    messages = database.get_all_messages_for_session(session_id)
    return render_template("admin_session.html", session_id=session_id, messages=messages)


@app.route("/admin/<session_id>/resolve", methods=["POST"])
def admin_resolve(session_id):
    database.mark_resolved(session_id)
    return redirect(url_for("admin_dashboard"))


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
