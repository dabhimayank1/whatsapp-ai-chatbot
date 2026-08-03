"""
ai_engine.py
------------
1) detect_escalation()  -> checks if user wants to talk to a real human /
                            client / management directly (Hindi + English keywords)
2) get_welcome_message() -> first greeting whenever a new session starts
3) get_ai_response()     -> normal AI (Claude) reply using chat history as context
"""

import os
from anthropic import Anthropic
import knowledge_base

COMPANY_NAME = os.getenv("COMPANY_NAME", "XYZ Industry")
WELCOME_TEMPLATE = os.getenv(
    "WELCOME_MESSAGE", "Hello! Welcome to {company}. How can I help you today?"
)

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    return _client

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
    Plain text reply. history: list of {"sender": "user"/"bot", "message": "..."}
    """
    if not os.getenv("ANTHROPIC_API_KEY"):
        return (
            "⚠️ AI abhi configure nahi hua hai. Please set ANTHROPIC_API_KEY in your .env file. "
            "(Ye ek placeholder reply hai.)"
        )

    messages = []
    for h in history[-10:]:  # last 10 messages as context
        role = "user" if h["sender"] == "user" else "assistant"
        messages.append({"role": role, "content": h["message"]})
    messages.append({"role": "user", "content": user_message})

    try:
        response = _get_client().messages.create(
            model="claude-sonnet-4-6",
            max_tokens=400,
            system=SYSTEM_PROMPT,
            messages=messages,
        )
        return response.content[0].text
    except Exception as e:
        return f"⚠️ AI se reply lene me error aaya: {e}"


def get_document_ai_response(caption: str, file_bytes: bytes, media_type: str, history: list) -> str:
    """
    Handles a PDF or image attachment sent by the user (e.g. via WhatsApp media message).
    Sends the actual file content to Claude natively so it can read/summarize/answer about it.
    """
    if not os.getenv("ANTHROPIC_API_KEY"):
        return (
            "⚠️ AI abhi configure nahi hua hai. Please set ANTHROPIC_API_KEY in your .env file. "
            "(Ye ek placeholder reply hai.)"
        )

    import base64
    b64_data = base64.b64encode(file_bytes).decode("utf-8")

    is_pdf = "pdf" in (media_type or "").lower()
    file_block = (
        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": b64_data}}
        if is_pdf
        else {"type": "image", "source": {"type": "base64", "media_type": media_type or "image/jpeg", "data": b64_data}}
    )

    messages = []
    for h in history[-10:]:
        role = "user" if h["sender"] == "user" else "assistant"
        messages.append({"role": role, "content": h["message"]})

    messages.append(
        {
            "role": "user",
            "content": [
                file_block,
                {"type": "text", "text": caption or "Please review this attached document and summarize it."},
            ],
        }
    )

    try:
        response = _get_client().messages.create(
            model="claude-sonnet-4-6",
            max_tokens=500,
            system=SYSTEM_PROMPT,
            messages=messages,
        )
        return response.content[0].text
    except Exception as e:
        return f"⚠️ Document padhne me error aaya: {e}"
