"""
knowledge_base.py
------------------
Ye file company ki 'industrial knowledge' rakhti hai jo AI ko system prompt ke
saath diya jaata hai. Isse bot ko har baar sochna nahi padta - directly accurate,
business-specific jawab de sakta hai.

>>> ISE APNE ACTUAL BUSINESS KE HISAAB SE EDIT KARO <<<
Neeche diya gaya content ek GENERIC industrial/manufacturing template hai.
Apne products, pricing, MOQ, certifications, delivery time etc. yahan daal do.
"""

COMPANY_PROFILE = """
COMPANY: XYZ Industry
INDUSTRY TYPE: Industrial Manufacturing / B2B Supplier
LOCATION: [Apna city/state yahan likho]
ESTABLISHED: [Saal]
CERTIFICATIONS: ISO 9001:2015 (Quality Management), [aur koi certification]
"""

PRODUCTS_AND_SERVICES = """
PRODUCTS / SERVICES OFFERED:
- [Product 1 - naam, specification, use-case]
- [Product 2 - naam, specification, use-case]
- [Service 1 - jaise custom fabrication, bulk supply, AMC/maintenance]
(Is list ko apne actual catalogue se replace karo)
"""

BUSINESS_POLICIES = """
COMMON BUSINESS POLICIES (industrial B2B standard - customize as needed):
- MOQ (Minimum Order Quantity): Bulk orders preferred; sample quantity bhi available hai on request.
- Payment Terms: Advance 30-50% + balance before dispatch (ya jo bhi aapka policy ho). LC (Letter of Credit) bhi accept karte hain bade orders ke liye.
- Delivery / Lead Time: Standard orders 7-15 working days; custom/bulk orders 3-4 weeks (adjust as per reality).
- Invoice: GST invoice diya jaata hai har order ke saath.
- Quality Assurance: Har batch ka COA (Certificate of Analysis) / quality report diya jaata hai.
- Warranty: [Apna warranty period likho, e.g. 1 year manufacturing defect warranty]
- Customization: Bulk custom orders available hain — specifications discuss karke quote diya jaata hai.
- Sample Request: First-time buyers ke liye sample bhejne ki facility hai (charges apply ho sakte hain).
- Shipping: Pan-India delivery + export bhi possible hai (customize as per business).
"""

INDUSTRIAL_TERMINOLOGY = """
COMMON INDUSTRIAL/B2B TERMS THE BOT SHOULD UNDERSTAND (use naturally, explain if asked):
- MOQ = Minimum Order Quantity
- FOB = Free On Board (buyer pays shipping from seller's port onward)
- Ex-Factory = Price without transportation, buyer arranges pickup
- LC = Letter of Credit (bank-guaranteed payment method for large B2B orders)
- COA = Certificate of Analysis (quality/testing report of a product batch)
- Lead Time = Time between order confirmation and dispatch
- AMC = Annual Maintenance Contract
- RFQ = Request for Quotation
- GST = Goods and Services Tax (India) - invoice number required for input credit
- HSN Code = Harmonized System Nomenclature (used for GST classification of goods)
"""

FAQ = """
FREQUENTLY ASKED QUESTIONS (answer these confidently and directly):
Q: Aapka MOQ kitna hai?
A: Product ke hisaab se vary karta hai — exact MOQ ke liye product name bataiye, main confirm kar dunga/dungi. Bulk orders par better pricing milti hai.

Q: Delivery kitne din me hogi?
A: Standard order 7-15 working days me deliver ho jaata hai. Custom/bulk order thoda zyada time le sakta hai — exact timeline order confirm hone ke baad milega.

Q: GST invoice milega?
A: Ji haan, har order ke saath proper GST invoice diya jaata hai.

Q: Quality certificate/COA milega?
A: Haan, har batch ke saath Certificate of Analysis diya jaata hai.

Q: Sample mil sakta hai order se pehle?
A: Ji haan, first-time buyers ke liye sample available hai. Quantity aur charges product ke hisaab se vary karte hain.

Q: Payment kaise karna hoga?
A: Advance + balance before dispatch standard hai. Bade orders ke liye LC bhi accept karte hain.

Q: Price kya hai?
A: Exact quotation product, quantity aur specifications par depend karta hai — bataiye kya chahiye, main best price nikal ke deta/deti hoon, ya team se connect kar deta hoon detailed quote ke liye.
"""


def get_full_knowledge_base() -> str:
    """Combines all knowledge sections into one block for the system prompt."""
    return "\n".join(
        [COMPANY_PROFILE, PRODUCTS_AND_SERVICES, BUSINESS_POLICIES, INDUSTRIAL_TERMINOLOGY, FAQ]
    )
