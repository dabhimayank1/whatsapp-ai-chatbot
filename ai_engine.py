"""
ai_engine.py
------------
1) detect_escalation()  -> checks if user wants to talk to a real human /
                            client / management directly (Hindi + English keywords)
2) get_welcome_message() -> first greeting whenever a new session starts
3) get_ai_response()     -> normal AI reply using chat history as context
                            Primary: Groq (free, high-volume, runs Llama models)
                            Fallback for documents/images: Gemini (native PDF/image reading)
"""

import os
import requests
import knowledge_base

COMPANY_NAME = os.getenv("COMPANY_NAME", "XYZ Industry")
WELCOME_TEMPLATE = os.getenv(
    "WELCOME_MESSAGE", "Hello! Welcome to {company}. How can I help you today?"
)

# PRIMARY: Groq - free forever, no credit card, high daily limit (great for multi-business/high-volume use)
# Get a free key at: https://console.groq.com/keys
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"

# FALLBACK (documents/images only): Google Gemini - free tier, native PDF/image reading
# Get a free key at: https://aistudio.google.com/apikey
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-flash-lite-latest")
GEMINI_API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

# Keywords (Hindi + English + Hinglish) that mean "connect me to a real person"
ESCALATION_KEYWORDS = [
    "talk to human", "talk to a human", "real person", "real agent",
    "talk to client", "talk to management", "talk to manager",
    "connect me to", "human agent", "customer care", "representative",
    "baat krni hai", "baat karni hai", "direct baat", "management se baat",
    "client se baat", "insaan se baat", "agent se baat", "manager se baat",
    "call me", "speak to someone", "human se baat", "owner se baat",
]


def detect_escalation(message: str) -> bool:
    text = message.lower()
    return any(keyword in text for keyword in ESCALATION_KEYWORDS)


def get_welcome_message() -> str:
    return WELCOME_TEMPLATE.format(company=COMPANY_NAME)


def get_escalation_reply() -> str:
    return (
        f"Sure! I'm connecting you to our team at {COMPANY_NAME} right now. 🙋‍♂️\n"
        "Ek real team member jald hi aapse yahin par contact karega. "
        "Tab tak, kya main aapki koi aur query me madad kar sakta hoon?"
    )


SYSTEM_PROMPT = (
    "You are a helpful, knowledgeable WhatsApp assistant, similar to ChatGPT. "
    "Answer ANY question the user asks using your full general knowledge — facts, "
    "places, recommendations, prices/estimates, definitions, calculations, advice, "
    "casual conversation, anything — not just questions about the business. Never "
    "refuse or redirect a question just because it's unrelated to the company; "
    "answer it helpfully like a normal AI assistant would.\n\n"
    "You also represent '{company}'. When the user asks specifically about THIS "
    "company's products, services, pricing, MOQ, delivery, certifications, or policies, "
    "use the BUSINESS KNOWLEDGE below as the accurate source of truth for that part of "
    "the answer. If a business-specific detail (like an exact custom quote) truly isn't "
    "in the knowledge base, say a team member will confirm it, or offer to connect them.\n\n"
    "Keep replies concise and WhatsApp-style (short paragraphs, use line breaks for lists), "
    "friendly, and reply in the same language style the user used (Hindi/English/Hinglish). "
    "If the user sends a document or image, read its actual content and answer specifically "
    "based on what's in it (e.g. summarize a PO/invoice/spec sheet, extract key numbers, etc).\n\n"
    "=== BUSINESS KNOWLEDGE ABOUT {company} ===\n{knowledge}\n=== END BUSINESS KNOWLEDGE ==="
).format(company=COMPANY_NAME, knowledge=knowledge_base.get_full_knowledge_base())


def get_ai_response(user_message: str, history: list) -> str:
    """
    Plain text reply via Groq (free, high daily limit - good for multi-business/high-volume use).
    history: list of {"sender": "user"/"bot", "message": "..."}
    """
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        return (
            "⚠️ AI abhi configure nahi hua hai. Please set GROQ_API_KEY in your .env file. "
            "(Ye ek placeholder reply hai. Free key: https://console.groq.com/keys)"
        )

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for h in history[-10:]:
        role = "user" if h["sender"] == "user" else "assistant"
        messages.append({"role": role, "content": h["message"]})
    messages.append({"role": "user", "content": user_message})

    payload = {"model": GROQ_MODEL, "messages": messages, "max_tokens": 500}
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    import time
    last_err = None
    for attempt in range(3):
        try:
            resp = requests.post(GROQ_API_URL, headers=headers, json=payload, timeout=30)
            data = resp.json()
            if resp.status_code in (503, 429) and attempt < 2:
                last_err = f"status {resp.status_code}, retrying"
                time.sleep(2)
                continue
            if resp.status_code != 200:
                err_msg = data.get("error", {}).get("message", str(data))
                return f"⚠️ AI se reply lene me error aaya ({resp.status_code}): {err_msg}"
            return data["choices"][0]["message"]["content"]
        except Exception as e:
            last_err = e
            time.sleep(2)
    return f"⚠️ AI abhi busy hai, please thodi der baad try karein. ({last_err})"


def _extract_pdf_text(file_bytes: bytes) -> str:
    """Extracts text from a PDF locally - completely free, no API calls, no rate limits."""
    from pypdf import PdfReader
    import io
    reader = PdfReader(io.BytesIO(file_bytes))
    text = ""
    for page in reader.pages:
        text += (page.extract_text() or "") + "\n"
    return text.strip()


def get_document_ai_response(caption: str, file_bytes: bytes, media_type: str, history: list) -> str:
    """
    Handles a PDF or image attachment sent by the user (e.g. via WhatsApp media message).

    PDFs: text is extracted locally (free, unlimited) then passed to Groq like a normal
    text message - no per-document API cost, no rate limit concern.

    Images: fall back to Gemini's vision (free tier) since Groq's free tier doesn't
    reliably support image/document uploads the same way. Only used occasionally
    (photos are rarer than PDFs), so Gemini's lower free quota is not a bottleneck here.
    """
    is_pdf = "pdf" in (media_type or "").lower()

    if is_pdf:
        try:
            pdf_text = _extract_pdf_text(file_bytes)
        except Exception as e:
            return f"⚠️ PDF padhne me error aaya: {e}"

        if not pdf_text:
            return (
                "⚠️ Is PDF se text nahi nikal paya — ho sakta hai ye scanned image PDF ho "
                "(text-based nahi). Please text-based PDF bhejiye, ya content type/screenshot bhej dijiye."
            )

        combined_message = (
            f"[User attached a PDF document. Extracted content below]\n\n{pdf_text[:6000]}\n\n"
            f"[User's message/question about it]: {caption or 'Please review this document and summarize it.'}"
        )
        return get_ai_response(combined_message, history)

    # Image - use Gemini vision as fallback
    gemini_key = os.getenv("GEMINI_API_KEY")
    if not gemini_key:
        return (
            "⚠️ Image padhne ke liye GEMINI_API_KEY bhi configure karni hogi (image support ke liye "
            "fallback). Free key: https://aistudio.google.com/apikey. PDF documents ke liye ye zaroorat nahi."
        )

    import base64
    b64_data = base64.b64encode(file_bytes).decode("utf-8")

    contents = []
    for h in history[-10:]:
        role = "user" if h["sender"] == "user" else "model"
        contents.append({"role": role, "parts": [{"text": h["message"]}]})

    contents.append({
        "role": "user",
        "parts": [
            {"inline_data": {"mime_type": media_type or "image/jpeg", "data": b64_data}},
            {"text": caption or "Please review this attached image and describe/answer about it."},
        ],
    })

    payload = {
        "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": contents,
    }

    try:
        resp = requests.post(f"{GEMINI_API_URL}?key={gemini_key}", json=payload, timeout=45)
        data = resp.json()
        if resp.status_code != 200:
            err_msg = data.get("error", {}).get("message", str(data))
            return f"⚠️ Image padhne me error aaya ({resp.status_code}): {err_msg}"
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as e:
        return f"⚠️ Image padhne me error aaya: {e}"
