# 🤖 WhatsApp AI Chatbot (ChatGPT-style) — Industrial Business

Ek AI chatbot jo WhatsApp par ChatGPT jaisa kaam karta hai:
- User "hi" bheje → bot professional welcome reply deta hai ("Hello, welcome to XYZ Industry...")
- Sawaalon ke smart AI answers deta hai (Claude AI powered)
- Agar user kahe **"mujhe client/management se baat karni hai"** → bot automatically escalate karke
  "connecting you to our team" bolta hai aur us conversation ko **admin dashboard** me highlight kar deta hai
- **Sari chat history backend SQLite database me save hoti hai** (`data/chats.db`)
- Website/app me easily embed ho sakta hai (webhook + API dono available hain)

---

## 📁 Folder Structure
```
whatsapp-ai-chatbot/
├── app.py               # Main Flask server (routes + webhook)
├── ai_engine.py         # AI replies + "talk to human" detection
├── database.py          # SQLite chat history storage
├── requirements.txt
├── .env.example         # copy to .env and fill your keys
├── templates/
│   ├── chat_demo.html    # Browser WhatsApp-style demo UI
│   ├── admin.html        # Dashboard - list all chats
│   └── admin_session.html
├── static/style.css
└── data/chats.db         # auto-created SQLite DB (chat history)
```

---

## 🚀 Quick Start (Test in Browser — no WhatsApp account needed)

```bash
# 1. Create virtual environment (recommended)
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Setup environment file
cp .env.example .env
# Open .env and paste your ANTHROPIC_API_KEY (get one free at https://console.anthropic.com/)

# 4. Run the server
python app.py
```

Ab browser me kholo: **http://127.0.0.1:5000**
Yahan par exact WhatsApp jaisi UI dikhegi jisme aap live chat test kar sakte ho.

Admin panel (sari chat history + "needs human" flags dekhne ke liye):
**http://127.0.0.1:5000/admin**

---

## 📲 Connect to REAL WhatsApp (Production) — Full Step-by-Step

Instagram par shareable link chahiye jo click karte hi **real WhatsApp** khole → uske liye 3 cheezein chahiye:
**(1) Backend kahi public host ho, (2) Twilio WhatsApp number, (3) us number ka `wa.me` link.**

### Step 1 — Backend ko Render.com par FREE deploy karo

1. https://github.com par ek naya repository banao aur is poore folder ko usme upload/push kar do
2. https://render.com par free account banao (GitHub se sign in kar sakte ho)
3. **New +** → **Web Service** → apna GitHub repo select karo
4. Settings:
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `gunicorn app:app --bind 0.0.0.0:$PORT` (already `Procfile` me hai)
   - **Environment Variables** me add karo: `ANTHROPIC_API_KEY`, `COMPANY_NAME`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (jo `.env.example` me hain)
5. Deploy hone ke baad Render ek public URL dega, jaise:
   ```
   https://whatsapp-ai-chatbot.onrender.com
   ```
   Ye 24/7 live rahega (free tier thoda slow start le sakta hai pehli request par).

### Step 2 — Twilio WhatsApp Number Setup

1. Free account: https://www.twilio.com/try-twilio
2. Console → **Messaging → Try it out → Send a WhatsApp message** (WhatsApp Sandbox)
3. Yahan ek **Sandbox number** (e.g. `+1 415 523 8886`) aur ek **join code** (e.g. `join happy-tiger`) milega
4. **Sandbox Settings** me "WHEN A MESSAGE COMES IN" field me apna Render URL + `/webhook` daalo:
   ```
   https://whatsapp-ai-chatbot.onrender.com/webhook
   ```

### Step 3 — Apna shareable `wa.me` Link Banao

Format:
```
https://wa.me/<sandbox_number_without_+_or_spaces>?text=join%20<your-join-code>
```
Example (agar number `+14155238886` aur code `join happy-tiger` hai):
```
https://wa.me/14155238886?text=join%20happy-tiger
```
Isi link ko Instagram bio/story me daal do. Jo bhi click karega, WhatsApp khulega, "join happy-tiger" pre-filled message dikhega, wo bas **Send** dabayega — turant bot se connect ho jayega, uske baad normal chat kar sakta hai.

⚠️ **Sandbox limitation**: Ye testing/demo ke liye perfect hai (free, instant), lekin har naye user ko pehli baar "join" message bhejna padta hai, aur Twilio ka branding/limits lagti hain. **Bade scale par public launch ke liye** Step 4 karo.

### Step 4 — Production: Apna Khud Ka WhatsApp Business Number (No "join" step)

Jab ready ho public launch ke liye (bina join code ke, apna khud ka number/naam dikhe):
1. Twilio Console → **Messaging → Senders → WhatsApp Senders** → apna business WhatsApp number register karo (Meta Business verification lagti hai, 1-3 din lag sakte hain)
2. Approval milne ke baad, wahi number `wa.me` link me use karo — bina join code ke:
   ```
   https://wa.me/91XXXXXXXXXX?text=Hi
   ```
3. Same webhook (`/webhook`) us number se bhi connect ho jayega — code change nahi karna padega.

---


## 🌐 Website / App me Embed Kaise Karein

Kyunki ye ek normal Flask REST API bhi hai, isko kisi bhi website ya app se easily connect kar sakte ho:

```javascript
// Kisi bhi website/app se
fetch("https://your-server.com/api/send", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    session_id: "user123",     // unique id per user/visitor
    message: "Hi, mujhe pricing chahiye"
  })
})
.then(res => res.json())
.then(data => console.log(data.reply));
```

Isse aap same AI bot ko:
- Company website ke chat widget me
- Instagram/Facebook Messenger me (webhook adapt karke)
- Apni mobile app me

sab jagah reuse kar sakte ho — logic ek hi jagah (`ai_engine.py` + `database.py`) rehta hai.

---

## ⚙️ Customize Karne Ke Liye

| Kya change karna hai | Kahan |
|---|---|
| Company ka naam / welcome message | `.env` → `COMPANY_NAME`, `WELCOME_MESSAGE` |
| **Industrial knowledge (products, MOQ, pricing, FAQs, terms)** | **`knowledge_base.py`** — ye bot ko business-specific accurate jawab dene me help karta hai |
| "Talk to human" trigger words | `ai_engine.py` → `ESCALATION_KEYWORDS` list |
| AI ka tone/behaviour | `ai_engine.py` → `SYSTEM_PROMPT` |
| Chat UI ka look | `static/style.css` |

---

## 🏭 Industrial Knowledge Base Kaise Customize Karein

`knowledge_base.py` file me 5 sections hain — apne actual business ke hisaab se edit karo:

1. **`COMPANY_PROFILE`** — company naam, location, certifications (ISO etc.)
2. **`PRODUCTS_AND_SERVICES`** — aapke actual products/services ki list
3. **`BUSINESS_POLICIES`** — MOQ, payment terms, delivery time, warranty, GST invoice, sample policy
4. **`INDUSTRIAL_TERMINOLOGY`** — MOQ, FOB, LC, COA jaise terms (already common hai, aur bhi add kar sakte ho)
5. **`FAQ`** — common sawaalon ke ready-made accurate jawab

Jitna detailed aur accurate ye file hogi, bot utna hi **valuable aur confident** reply dega —
kyunki wo guess nahi karega, seedha aapki di hui real information use karega.

⚠️ **Important**: Isme kabhi bhi wrong/outdated pricing ya policy mat rakhna — bot usi ko sach maan ke customer ko bata dega.

---

## ❓ Escalation Kaise Kaam Karta Hai

Jab user message me ye jaise words hote hain: *"client se baat karni hai"*, *"management se baat"*,
*"talk to human"*, *"representative"*, etc. — bot automatically:
1. User ko reply karta hai ki team connect ki ja rahi hai
2. Us session ko database me `escalated` mark kar deta hai
3. `/admin` dashboard par red **"Needs Human"** badge ke saath dikhta hai — taaki aap turant reply kar sakein

---

## 🔒 Notes
- Har user ki poori chat history `data/chats.db` (SQLite) me safe rehti hai
- API key `.env` file me rakhi jaati hai, kabhi bhi code me hardcode mat karo
- `.env` file ko GitHub par kabhi push mat karna (already `.gitignore` me add hai)
