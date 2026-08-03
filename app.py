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
@app.route("/debug-env-list")
def debug_env_list():
    keys = sorted(os.environ.keys())
    relevant = [k for k in keys if "TWILIO" in k.upper() or "GEMINI" in k.upper() or "COMPANY" in k.upper()]
    return jsonify({"likely_relevant_names": relevant})


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
@app.route("/meta-webhook", methods=["GET"])
def meta_webhook_verify():
    """
    Meta calls this with GET once, to verify your webhook, when you paste the URL
    into the Meta for Developers > WhatsApp > Configuration > Webhook field.
    """
    verify_token = os.getenv("META_VERIFY_TOKEN", "changeme123")
    mode = request.args.get("hub.mode")
    token = request.args.get("hub.verify_token")
    challenge = request.args.get("hub.challenge")

    if mode == "subscribe" and token == verify_token:
        return challenge, 200
    return "Verification failed", 403


@app.route("/meta-webhook", methods=["POST"])
def meta_webhook_receive():
    """
    Meta (WhatsApp Cloud API - FREE, no Twilio needed) sends incoming messages here as JSON.
    Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
    """
    data = request.get_json(force=True, silent=True) or {}
    try:
        entry = data["entry"][0]
        change = entry["changes"][0]["value"]
        messages = change.get("messages")
        if not messages:
            return jsonify({"status": "ignored"}), 200  # e.g. delivery/read status updates

        msg = messages[0]
        from_number = msg["from"]  # e.g. "919876543210" (no 'whatsapp:' prefix, no '+')
        msg_type = msg.get("type", "text")

        if msg_type == "text":
            incoming_msg = msg["text"]["body"]
            thread = threading.Thread(
                target=_process_and_send_meta_reply,
                args=(from_number, incoming_msg, None, None),
                daemon=True,
            )
            thread.start()
        elif msg_type in ("document", "image"):
            media_id = msg[msg_type]["id"]
            caption = msg[msg_type].get("caption", "")
            mime_type = msg[msg_type].get("mime_type", "application/pdf")
            thread = threading.Thread(
                target=_process_and_send_meta_reply,
                args=(from_number, caption, media_id, mime_type),
                daemon=True,
            )
            thread.start()

    except (KeyError, IndexError, TypeError) as e:
        print(f"[meta-webhook] Ignoring non-message event or parse issue: {e}", flush=True)

    return jsonify({"status": "received"}), 200


def _process_and_send_meta_reply(from_number, caption_or_text, media_id, mime_type):
    """Runs in a background thread - generates reply, sends via Meta Graph API."""
    import traceback
    session_id = f"whatsapp:+{from_number}"
    try:
        if media_id:
            file_bytes = _download_meta_media(media_id)
            history = database.get_history(session_id)
            if not history:
                welcome = ai_engine.get_welcome_message()
                database.save_message(session_id, "bot", welcome)
                history = database.get_history(session_id)
            database.save_message(session_id, "user", f"📎 [attachment]" + (f"\n{caption_or_text}" if caption_or_text else ""))
            reply = ai_engine.get_document_ai_response(caption_or_text, file_bytes, mime_type, history)
            database.save_message(session_id, "bot", reply)
        else:
            reply, _escalated = handle_incoming_message(session_id, caption_or_text)
        print(f"[meta-webhook] Generated reply for {from_number}: {reply[:80]}...", flush=True)
        _send_meta_whatsapp_message(from_number, reply)
    except Exception as e:
        print(f"[meta-webhook] ERROR: {e}", flush=True)
        traceback.print_exc()
        try:
            _send_meta_whatsapp_message(from_number, "⚠️ Kuch error aa gaya, please try again.")
        except Exception:
            traceback.print_exc()


def _download_meta_media(media_id: str) -> bytes:
    """Meta gives a media ID, not a direct URL. Two-step download: get URL, then fetch it."""
    token = os.getenv("META_ACCESS_TOKEN")
    headers = {"Authorization": f"Bearer {token}"}
    meta_info = requests.get(f"https://graph.facebook.com/v20.0/{media_id}", headers=headers, timeout=20).json()
    media_url = meta_info["url"]
    file_resp = requests.get(media_url, headers=headers, timeout=30)
    return file_resp.content


def _send_meta_whatsapp_message(to_number: str, body: str):
    """Sends a WhatsApp message via Meta's official Cloud API (free for replies)."""
    import traceback
    token = os.getenv("META_ACCESS_TOKEN")
    phone_number_id = os.getenv("META_PHONE_NUMBER_ID")

    if not token or not phone_number_id:
        print("[meta-webhook] Missing META_ACCESS_TOKEN / META_PHONE_NUMBER_ID - cannot send message", flush=True)
        return

    url = f"https://graph.facebook.com/v20.0/{phone_number_id}/messages"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload = {
        "messaging_product": "whatsapp",
        "to": to_number,
        "type": "text",
        "text": {"body": body},
    }
    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=20)
        if resp.status_code == 200:
            print(f"[meta-webhook] Message sent successfully to {to_number}", flush=True)
        else:
            print(f"[meta-webhook] FAILED to send ({resp.status_code}): {resp.text}", flush=True)
    except Exception as e:
        print(f"[meta-webhook] FAILED to send: {e}", flush=True)
        traceback.print_exc()


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
    import traceback
    try:
        if num_media > 0:
            reply = handle_incoming_media(from_number, incoming_msg, media_url, media_type)
        else:
            reply, _escalated = handle_incoming_message(from_number, incoming_msg)
        print(f"[webhook] Generated reply for {from_number}: {reply[:80]}...", flush=True)
        _send_whatsapp_message(from_number, reply)
    except Exception as e:
        print(f"[webhook] ERROR generating/sending reply: {e}", flush=True)
        traceback.print_exc()
        try:
            _send_whatsapp_message(from_number, f"⚠️ Kuch error aa gaya, please try again.")
        except Exception:
            traceback.print_exc()


def _send_whatsapp_message(to_number: str, body: str):
    """Sends a WhatsApp message via Twilio's REST API (not the webhook TwiML response)."""
    import traceback
    from twilio.rest import Client

    account_sid = os.getenv("TWILIO_ACCOUNT_SID")
    auth_token = os.getenv("TWILIO_AUTH_TOKEN")
    from_whatsapp = os.getenv("TWILIO_WHATSAPP_NUMBER", "whatsapp:+14155238886")

    if not account_sid or not auth_token:
        print("[webhook] Twilio credentials missing (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN) - cannot send message", flush=True)
        return

    try:
        client = Client(account_sid, auth_token)
        msg = client.messages.create(from_=from_whatsapp, to=to_number, body=body)
        print(f"[webhook] Message sent successfully. SID: {msg.sid}, status: {msg.status}", flush=True)
    except Exception as e:
        print(f"[webhook] FAILED to send WhatsApp message via Twilio: {e}", flush=True)
        traceback.print_exc()


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
    return render_template("admin.html", sessions=sessions, company_name=ai_engine.COMPANY_NAME)


@app.route("/admin/<session_id>")
def admin_session(session_id):
    messages = database.get_all_messages_for_session(session_id)
    return render_template("admin_session.html", session_id=session_id, messages=messages, company_name=ai_engine.COMPANY_NAME)


@app.route("/admin/<session_id>/resolve", methods=["POST"])
def admin_resolve(session_id):
    database.mark_resolved(session_id)
    return redirect(url_for("admin_dashboard"))


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
