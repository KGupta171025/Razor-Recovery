import os
import json
import logging
from datetime import datetime, timedelta, timezone
from google import genai
from google.genai import types

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("RazorRecoveryAgent")

# Initialize Gemini Client
API_KEY = os.environ.get("GEMINI_API_KEY")
HAS_API_KEY = bool(API_KEY)
client = None

if HAS_API_KEY:
    try:
        client = genai.Client(api_key=API_KEY)
        logger.info("Gemini API successfully configured using new google-genai client.")
    except Exception as e:
        logger.error(f"Failed to configure Gemini Client: {e}")
        HAS_API_KEY = False
else:
    logger.info("No GEMINI_API_KEY found. Running in simulation fallback mode.")

def call_llm(prompt: str, system_instruction: str = "") -> str:
    """Helper function to call Gemini with a prompt and system instructions, with mock fallback."""
    if not HAS_API_KEY or not client:
        return ""
    try:
        response = client.models.generate_content(
            model="gemini-1.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                system_instruction=system_instruction,
            ),
        )
        return response.text.strip()
    except Exception as e:
        logger.error(f"Gemini API call failed: {e}. Falling back to simulation logic.")
        return ""

def diagnose_payment_failure(payment_id: str, amount: float, method: str, failure_code: str, failure_desc: str, customer_name: str) -> dict:
    """Diagnoses payment failure and recommends the best recovery strategy."""
    system_instruction = (
        "You are an expert Payment Risk and Recovery Agent at Razorpay. "
        "Analyze payment failures and return a JSON object with: "
        "'diagnosis' (clean user-friendly description), "
        "'recommended_strategy' (one of: SILENT_RETRY, ACTION_REQUIRED_EMAIL, GATEWAY_SWITCH, alternative payment, DISCOUNT_OFFER), "
        "'delay_hours' (integer delay before next retry/email), "
        "'reasoning' (why you chose this strategy)."
    )
    
    prompt = f"""
    Analyze this payment failure event:
    - Payment ID: {payment_id}
    - Amount: INR {amount}
    - Method: {method}
    - Failure Code: {failure_code}
    - Failure Description: {failure_desc}
    - Customer Name: {customer_name}
    
    Return the response as a JSON object matching the instructions.
    """
    
    if HAS_API_KEY:
        response_text = call_llm(prompt, system_instruction)
        if response_text:
            try:
                return json.loads(response_text)
            except json.JSONDecodeError:
                pass

    # Mock Fallback Engine (highly detailed and deterministic)
    failure_code_upper = (failure_code or "").upper()
    failure_desc_lower = (failure_desc or "").lower()
    
    result = {
        "diagnosis": "Technical error or authorization mismatch.",
        "recommended_strategy": "ACTION_REQUIRED_EMAIL",
        "delay_hours": 2,
        "reasoning": "Standard technical failure. Advise merchant to check credentials and buyer to retry."
    }
    
    if "INSUFFICIENT" in failure_code_upper or "balance" in failure_desc_lower:
        result["diagnosis"] = "The customer's bank account or card has insufficient funds."
        result["recommended_strategy"] = "SILENT_RETRY"
        result["delay_hours"] = 24  # Wait 24 hours (possibly salary day or fund transfer)
        result["reasoning"] = "Insufficient funds is usually a temporary liquidity issue. Scheduling a smart retry for 24 hours later, combined with a gentle SMS reminder."
    elif "CREDENTIALS" in failure_code_upper or "otp" in failure_desc_lower or "password" in failure_desc_lower:
        result["diagnosis"] = "Customer entered incorrect OTP or authentication details."
        result["recommended_strategy"] = "ACTION_REQUIRED_EMAIL"
        result["delay_hours"] = 0  # Immediate outreach
        result["reasoning"] = "Authentication issues require immediate customer correction. Sending an immediate checkout link to re-attempt payment."
    elif "LIMIT" in failure_code_upper or "exceeded" in failure_desc_lower:
        result["diagnosis"] = "Transaction exceeded bank or card limits."
        result["recommended_strategy"] = "alternative payment"
        result["delay_hours"] = 1
        result["reasoning"] = "Limit exceeded. Recommending the customer retry using a different payment instrument, e.g., UPI instead of Netbanking."
    elif "TIMEOUT" in failure_code_upper or "down" in failure_desc_lower or "network" in failure_desc_lower:
        result["diagnosis"] = "Temporary bank gateway timeout or system downtime."
        result["recommended_strategy"] = "GATEWAY_SWITCH"
        result["delay_hours"] = 4
        result["reasoning"] = "Bank downtime resolved dynamically. Will retry silently after 4 hours or switch routing internally."
    elif amount > 5000 and "abandon" in failure_desc_lower:
        result["diagnosis"] = "High-value cart abandonment due to price friction."
        result["recommended_strategy"] = "DISCOUNT_OFFER"
        result["delay_hours"] = 2
        result["reasoning"] = "Cart abandonment on high value item. Suggesting a 5% instant discount to close the sale."
        
    return result

def generate_communication(entity_type: str, entity_details: dict, channel: str, contact_count: int = 1) -> dict:
    """Generates personalized recovery emails/SMS text based on the customer history."""
    system_instruction = (
        "You are an empathetic, professional recovery writing assistant. "
        "Generate a recovery notification. Return a JSON object with: "
        "'subject' (email subject line, null if SMS/voice), "
        "'body' (the message text. Use friendly, empathetic but clear tone. Include checkout link placeholder: {{checkout_url}}), "
        "'estimated_impact' (high, medium, low)."
    )
    
    prompt = f"""
    Generate recovery outreach:
    - Entity Type: {entity_type} (invoice / payment_failed / checkout_abandoned)
    - Customer Name: {entity_details.get('customer_name', 'Customer')}
    - Amount: INR {entity_details.get('amount', 0.0)}
    - Contact Chase Sequence Number: {contact_count} (1 = polite first nudge, 2 = firm intermediate, 3 = final warning)
    - Channel: {channel} (email / sms)
    - Additional details: {entity_details.get('details', '')}
    
    Return the response as a JSON object matching the instructions.
    """
    
    if HAS_API_KEY:
        response_text = call_llm(prompt, system_instruction)
        if response_text:
            try:
                return json.loads(response_text)
            except json.JSONDecodeError:
                pass

    # Mock Fallback Engine
    customer_name = entity_details.get('customer_name', 'Customer')
    amount = entity_details.get('amount', 0.0)
    checkout_url = f"http://localhost:8000/checkout/{entity_details.get('id', 'mock_id')}"
    
    result = {
        "subject": "",
        "body": "",
        "estimated_impact": "medium"
    }
    
    if channel == "email":
        if entity_type == "invoice":
            if contact_count == 1:
                result["subject"] = f"Friendly Reminder: Outstanding Invoice from Razorpay Merchant (INR {amount})"
                result["body"] = f"Hi {customer_name},\n\nWe hope you are doing well. This is a gentle reminder that invoice {entity_details.get('id', '')} for INR {amount} is now due.\n\nYou can review and complete your payment easily by clicking the secure checkout link below:\n{checkout_url}\n\nThank you,\nFinance Department"
                result["estimated_impact"] = "high"
            elif contact_count == 2:
                result["subject"] = f"Overdue Invoice Alert: Payment Needed for Invoice {entity_details.get('id', '')}"
                result["body"] = f"Dear {customer_name},\n\nWe have not received payment for invoice {entity_details.get('id', '')} of INR {amount}, which was due recently.\n\nPlease complete the payment at your earliest convenience to avoid service interruptions. You can pay securely here:\n{checkout_url}\n\nIf you have any questions or need to discuss payment terms, please reply directly to this email.\n\nBest regards,\nAccounts Receivable Team"
                result["estimated_impact"] = "medium"
            else:
                result["subject"] = f"URGENT: Final Notice for Unpaid Invoice {entity_details.get('id', '')}"
                result["body"] = f"Dear {customer_name},\n\nDespite previous reminders, invoice {entity_details.get('id', '')} of INR {amount} remains unpaid. This is our final notice before we must escalate this case or restrict account access.\n\nPlease settle this immediately using the link below:\n{checkout_url}\n\nIf you require assistance or a payment deferral, please reply immediately.\n\nSincerely,\nFinance Operations Lead"
                result["estimated_impact"] = "medium"
                
        elif entity_type == "payment_failed":
            result["subject"] = "We couldn't process your payment. Let's fix it!"
            result["body"] = f"Hi {customer_name},\n\nIt looks like your recent payment of INR {amount} failed due to a bank transaction issue. Don't worry, your order has been saved!\n\nYou can easily complete your checkout using a different card or UPI by clicking this secure link:\n{checkout_url}\n\nIf you experienced any technical difficulty, please reply to this email so we can assist.\n\nWarm regards,\nCheckout Support Team"
            result["estimated_impact"] = "high"
            
        else: # checkout_abandoned
            result["subject"] = "Did you forget something? Complete your order now!"
            result["body"] = f"Hi {customer_name},\n\nWe noticed you left some items in your cart. We've saved them for you!\n\nTo help you complete your order, we've applied a small checkout credit. Click below to complete your payment of INR {amount} now:\n{checkout_url}\n\nBest,\nSales Team"
            result["estimated_impact"] = "high"
            
    else: # SMS
        if entity_type == "invoice":
            result["body"] = f"Hi {customer_name}, invoice {entity_details.get('id', '')} of INR {amount} is overdue. Pay securely: {checkout_url}"
        elif entity_type == "payment_failed":
            result["body"] = f"Hi {customer_name}, your payment of INR {amount} failed. Retry securely using UPI/Card here: {checkout_url}"
        else:
            result["body"] = f"Hi {customer_name}, you left items in your cart. Complete purchase: {checkout_url}"
        result["estimated_impact"] = "medium"
        
    return result

def parse_customer_reply(reply_content: str, invoice_details: dict) -> dict:
    """Parses customer replies to detect promise-to-pay, opt-out requests, or disputes."""
    system_instruction = (
        "You are an AI Billing Assistant. Analyze the user reply and return a JSON object with: "
        "'intent' (one of: PROMISE_TO_PAY, DISPUTE, OPT_OUT, GENERAL_QUERY), "
        "'promised_date' (in YYYY-MM-DD format if intent is PROMISE_TO_PAY, else null), "
        "'action_required' (description of action the merchant needs to take), "
        "'suggested_reply' (a short, polite response acknowledging the user's message)."
    )
    
    prompt = f"""
    Analyze the customer's email reply:
    - Customer Email Content: "{reply_content}"
    - Invoice Details: ID {invoice_details.get('id')}, Amount INR {invoice_details.get('amount')}, Due Date {invoice_details.get('due_at')}
    
    Return the response as a JSON object matching the instructions.
    """
    
    if HAS_API_KEY:
        response_text = call_llm(prompt, system_instruction)
        if response_text:
            try:
                return json.loads(response_text)
            except json.JSONDecodeError:
                pass

    # Mock Fallback Engine (Advanced matching using keywords)
    reply_lower = reply_content.lower()
    
    result = {
        "intent": "GENERAL_QUERY",
        "promised_date": None,
        "action_required": "Respond to user's query about invoice details.",
        "suggested_reply": "Thank you for reaching out. We will look into this and get back to you shortly."
    }
    
    # 1. OPT OUT
    if any(k in reply_lower for k in ["stop", "remove", "unsubscribe", "don't email", "spam", "quit"]):
        result["intent"] = "OPT_OUT"
        result["action_required"] = "Opt customer out of automated dunning emails immediately to ensure compliance."
        result["suggested_reply"] = "We have stopped automated reminders for this invoice. You can still pay at your convenience."
        
    # 2. DISPUTE
    elif any(k in reply_lower for k in ["dispute", "wrong", "charged already", "unfair", "fraud", "scam", "already paid", "haven't received", "never got"]):
        result["intent"] = "DISPUTE"
        result["action_required"] = "Flag invoice as disputed. Halt automated reminders. Assign to support agent."
        result["suggested_reply"] = "We are sorry for the issue. We have paused reminders and escalations while our billing team reviews your account details."
        
    # 3. PROMISE TO PAY
    elif any(k in reply_lower for k in ["pay next", "will pay", "transfer on", "salary", "tomorrow", "tuesday", "monday", "friday", "saturday", "sunday", "next week", "later"]):
        result["intent"] = "PROMISE_TO_PAY"
        
        # Calculate a mock promised date based on keywords
        promised = datetime.now(timezone.utc).replace(tzinfo=None)
        if "tomorrow" in reply_lower:
            promised += timedelta(days=1)
        elif "next week" in reply_lower:
            promised += timedelta(days=7)
        elif "monday" in reply_lower:
            # find next monday
            days_ahead = 0 - promised.weekday()
            if days_ahead <= 0: days_ahead += 7
            promised += timedelta(days=days_ahead)
        elif "tuesday" in reply_lower:
            days_ahead = 1 - promised.weekday()
            if days_ahead <= 0: days_ahead += 7
            promised += timedelta(days=days_ahead)
        else:
            promised += timedelta(days=3) # Default 3 days delay
            
        result["promised_date"] = promised.strftime("%Y-%m-%d")
        result["action_required"] = f"Log promise-to-pay date ({result['promised_date']}). Pause notifications until that date."
        result["suggested_reply"] = f"Thank you! We have updated our records. We will temporarily pause automated reminders until {result['promised_date']}."
        
    return result

def generate_hinglish_voice_script(entity_details: dict, sequence_number: int) -> dict:
    """Generates a Hinglish-based conversational voice recovery script."""
    system_instruction = (
        "You are a friendly, bilingual (English & Hindi) collections specialist calling an Indian customer. "
        "Generate a Hinglish recovery transcript. Return a JSON object with: "
        "'transcript' (dialog script formatted as: 'Agent: ... \\nCustomer: ...'), "
        "'suggested_next_step' (actions to take)."
    )
    
    prompt = f"""
    Generate a Hinglish recovery voice call conversation:
    - Customer Name: {entity_details.get('customer_name', 'Customer')}
    - Amount Due: INR {entity_details.get('amount', 0.0)}
    - Reference ID: {entity_details.get('id', 'pay_xxx')}
    - Sequence Contact Number: {sequence_number} (1 = initial query, 2 = firm follow up, 3 = final notice)
    
    Return the response as a JSON object matching the instructions.
    """
    
    if HAS_API_KEY and client:
        response_text = call_llm(prompt, system_instruction)
        if response_text:
            try:
                return json.loads(response_text)
            except json.JSONDecodeError:
                pass

    # Mock Fallback Engine
    customer_name = entity_details.get('customer_name', 'Customer')
    amount = entity_details.get('amount', 0.0)
    ref_id = entity_details.get('id', 'pay_xxx')
    
    transcript = ""
    next_step = "Wait for payment"
    
    if sequence_number == 1:
        transcript = (
            f"Agent: Hello, kya meri baat {customer_name} ji se ho rahi hai?\\n"
            f"Customer: Haan, main bol raha hoon. Kaun?\\n"
            f"Agent: Namaste sir, main Razorpay recovery assistant bol raha hoon regarding your order. "
            f"Humne notice kiya ki ₹{amount:,.2f} ka payment initiate hua tha par status failed aa raha hai due to gateway check. "
            f"Kya aapko checkout pe koi issue face karna pada, sir?\\n"
            f"Customer: Yaar, OTP hi nahi aaya mere bank se. Phir maine drop kar diya.\\n"
            f"Agent: Ah, samajh sakta hoon sir, bank network down hone ki wajah se OTP issue ho jata hai. "
            f"Maine aapki registration email pe ek direct UPI option aur fresh checkout link send kiya hai, aap wahan se simple try kar sakte hain. "
            f"Kya main call pe wait karoon jab tak aap pay karte hain?\\n"
            f"Customer: Chalo, theek hai. Main check karta hoon link."
        )
        next_step = "Send alternate UPI link and wait."
    elif sequence_number == 2:
        transcript = (
            f"Agent: Namaste {customer_name} ji, main Razorpay finance desk se baat kar raha hoon relative to invoice {ref_id}.\\n"
            f"Customer: Haan ji, boliye.\\n"
            f"Agent: Sir, ₹{amount:,.2f} ka payment scheduled tha 15th ko, par hume abhi tak receive nahi hua. "
            f"Is there any cash flow problem or should we update your bank mandate?\\n"
            f"Customer: Nahi actually hamare manager out of town hain. Main Tuesday tak transfer karwa dunga.\\n"
            f"Agent: Ok Tuesday, standard business hours ke andar? Sure sir, main is promise-to-pay date ko log kar leta hoon. "
            f"Hume temporary email reminders halt karne me khushi hogi. Tuesday sham tak updates cross-check karte hain. Dhanyawad!"
        )
        next_step = "Set promise-to-pay date in DB and pause reminders."
    else:
        transcript = (
            f"Agent: Hello, {customer_name} ji? Main team accounts receivable se call kar raha hoon final warning update ke liye.\\n"
            f"Customer: Dekho bhai, abhi hamare paas funds nahi hain. Agle month hi ho payega.\\n"
            f"Agent: Sir, details checking se pata chala ki invoice {ref_id} for ₹{amount:,.2f} is pending for more than 45 days. "
            f"Hamari policy ke under hum reminders aur delay limit breach kar chuke hain. "
            f"If payment is not cleared by tomorrow, system automatically restrictions alert release kar dega accounts pe.\\n"
            f"Customer: Acha, main management se discuss karke bank transfer initiate karwata hoon jald se jald."
        )
        next_step = "Escalate to direct collections agent dashboard."
        
    return {"transcript": transcript, "suggested_next_step": next_step}

def parse_natural_language_query(user_query: str) -> dict:
    """Parses natural language user inputs into structured filter criteria using Gemini or regex fallback."""
    system_instruction = (
        "You are an AI database query parser for RazorRecovery. "
        "Translate the user's natural language filter query into structured JSON criteria. "
        "Fields: "
        "- bank: 'HDFC', 'ICICI', 'SBI', 'UPI' (exact match, or null) "
        "- min_amount: float (or null) "
        "- max_amount: float (or null) "
        "- stage: 'INGESTED', 'DIAGNOSED', 'CHASING', 'RECOVERED', 'GATED', 'STOPPED' (or null) "
        "- contact_count: integer (or null) "
        "- recovery_campaign_status: 'IDLE', 'ACTIVE', 'PAUSED', 'STOPPED_LIMIT', 'STOPPED_OPT_OUT', 'COMPLETED' (or null) "
        "Return ONLY a JSON block, no markdown, no other keys."
    )
    prompt = f"Translate this query: '{user_query}'"
    
    if HAS_API_KEY:
        response_text = call_llm(prompt, system_instruction)
        if response_text:
            try:
                cleaned = response_text.replace("```json", "").replace("```", "").strip()
                return json.loads(cleaned)
            except Exception:
                pass
                
    # Fallback regex-based heuristic parser
    query_lower = user_query.lower()
    filters = {
        "bank": None,
        "min_amount": None,
        "max_amount": None,
        "stage": None,
        "contact_count": None,
        "recovery_campaign_status": None
    }
    
    # Simple bank matching
    for b in ["hdfc", "icici", "sbi", "upi"]:
        if b in query_lower:
            filters["bank"] = b.upper()
            
    # Simple stage matching
    for s in ["ingested", "diagnosed", "chasing", "recovered", "gated", "stopped"]:
        if s in query_lower:
            filters["stage"] = s.upper()
            
    # Simple amount matching (above/below)
    import re
    amounts = [int(x) for x in re.findall(r'\d+', query_lower)]
    if amounts:
        val = amounts[0]
        if any(k in query_lower for k in ["above", "more than", "greater than", ">", "over", "at least"]):
            filters["min_amount"] = float(val)
        elif any(k in query_lower for k in ["below", "less than", "<", "under"]):
            filters["max_amount"] = float(val)
        else:
            if len(amounts) > 1:
                filters["min_amount"] = float(amounts[0])
                filters["max_amount"] = float(amounts[1])
            else:
                filters["min_amount"] = float(val)
                
    if "retry" in query_lower or "contact" in query_lower or "attempt" in query_lower:
        for x in amounts:
            if x < 10:
                filters["contact_count"] = x
                break
                
    if "opt-out" in query_lower or "opt out" in query_lower:
        filters["recovery_campaign_status"] = "STOPPED_OPT_OUT"
    elif "pause" in query_lower:
        filters["recovery_campaign_status"] = "PAUSED"
    elif "completed" in query_lower or "recovered" in query_lower:
        filters["recovery_campaign_status"] = "COMPLETED"
        
    return filters

def compute_ai_recommendation(entity_id: str, amount: float, bank: str, stage: str, contact_count: int, status: str) -> dict:
    """Computes dynamic recovery probability index and contextual AI agent action recommendation."""
    system_instruction = (
        "You are the AI Recovery Optimizer for RazorRecovery. "
        "Analyze the case context and generate a JSON object with: "
        "- probability: integer (0 to 100 representing recovery likelihood) "
        "- reasoning: string (brief explanation of the score) "
        "- recommended_action: string (e.g. 'induce_gateway_failure', 'customer_opt_out', 'dispute_trigger', 'normal') "
        "- action_label: string (short user-friendly button text like 'Reroute to HDFC' or 'Resolve Dispute')"
    )
    prompt = f"""
    Analyze this case:
    - ID: {entity_id}
    - Amount: {amount}
    - Associated Bank: {bank}
    - Current Stage: {stage}
    - Contact Count: {contact_count}
    - Status: {status}
    """
    
    if HAS_API_KEY:
        response_text = call_llm(prompt, system_instruction)
        if response_text:
            try:
                cleaned = response_text.replace("```json", "").replace("```", "").strip()
                return json.loads(cleaned)
            except Exception:
                pass
                
    # Fallback heuristic engine
    probability = 85
    reasoning = "Normal transaction health. Standard automated retry sequence is highly recommended."
    recommended_action = "normal"
    action_label = "Proceed Sequence"
    
    bank_upper = (bank or "").upper()
    stage_upper = (stage or "").upper()
    status_upper = (status or "").upper()
    
    if status_upper == "FAILED" and stage_upper == "PAUSED":
        probability = 45
        reasoning = "Customer raised a billing claim. High chargeback risk. Resolve immediately."
        recommended_action = "dispute_trigger"
        action_label = "Refund & Close Case"
    elif bank_upper in ["HDFC", "SBI", "ICICI"] and stage_upper == "GATED":
        probability = 60
        reasoning = f"Active bank gateway downtime detected on {bank_upper}. Switch routing nodes."
        recommended_action = "induce_gateway_failure"
        action_label = "Reroute Gateway Node"
    elif contact_count >= 2:
        probability = 70
        reasoning = "Multiple outreach attempts ignored. Settle dispute or mark opt-out."
        recommended_action = "customer_opt_out"
        action_label = "Force Cancel Campaign"
    elif amount > 50000:
        probability = 92
        reasoning = "High-value corporate customer. Standard VIP retry sequence bypass active."
        recommended_action = "normal"
        action_label = "Proceed VIP Bypass"
        
    return {
        "probability": probability,
        "reasoning": reasoning,
        "recommended_action": recommended_action,
        "action_label": action_label
    }


