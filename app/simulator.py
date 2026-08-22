import random
import json
from datetime import datetime, timedelta, timezone
from sqlalchemy.orm import Session
from app.models import Invoice, Payment, AuditLog, Communication
from app.agent import diagnose_payment_failure, generate_communication, parse_customer_reply

# Synthetic Data Templates
CUSTOMER_TEMPLATES = [
    {"name": "Aditya Sharma", "email": "aditya.sharma@example.com", "phone": "+91 98765 43210"},
    {"name": "Priyanka Patel", "email": "priyanka.patel@example.com", "phone": "+91 87654 32109"},
    {"name": "Rahul Verma", "email": "rahul.verma@example.com", "phone": "+91 76543 21098"},
    {"name": "Sneha Reddy", "email": "sneha.reddy@example.com", "phone": "+91 95432 10987"},
    {"name": "Vikram Malhotra", "email": "vikram.m@malhotratech.in", "phone": "+91 91234 56789"},
    {"name": "Ananya Sen", "email": "ananya.sen@example.com", "phone": "+91 92345 67890"},
    {"name": "Amit Gupta", "email": "amit.g@guptaretail.com", "phone": "+91 93456 78901"},
    {"name": "Meera Joshi", "email": "meera.j@joshiconsulting.in", "phone": "+91 94567 89012"},
    {"name": "Rohan Das", "email": "rohan.das@example.com", "phone": "+91 95678 90123"},
    {"name": "Kriti Nair", "email": "kriti.nair@example.com", "phone": "+91 96789 01234"},
]

FAILURE_REASONS = [
    ("BAD_CREDENTIALS", "Incorrect card expiration or incorrect OTP security code."),
    ("INSUFFICIENT_FUNDS", "The account has insufficient balance to complete the transaction."),
    ("GATEWAY_TIMEOUT", "The bank network failed to respond in time. Please try again."),
    ("LIMIT_EXCEEDED", "The customer has exceeded their daily spending limit set by the card issuer."),
]

MOCK_REPLIES = [
    "I will pay this tomorrow once I get home.",
    "Please unsubscribe me. I don't want these emails anymore.",
    "The transaction failed but I was charged. This is wrong, check my account.",
    "I'll pay on Monday for sure.",
    "I am currently traveling. Will transfer next Tuesday.",
    "Why am I getting this? I didn't place any order.",
]

def seed_synthetic_data(db: Session):
    """Seeds the database with 55 high-quality records of failed payments, checkout drop-offs, and invoices."""
    # Clear existing data to allow clean simulation runs
    db.query(AuditLog).delete()
    db.query(Communication).delete()
    db.query(Payment).delete()
    db.query(Invoice).delete()
    db.commit()

    now = datetime.now(timezone.utc).replace(tzinfo=None)

    # 1. Seed 20 Overdue B2B/B2C Invoices
    for i in range(1, 21):
        cust = random.choice(CUSTOMER_TEMPLATES)
        amount = round(random.uniform(5000, 150000), 2)
        created_days_ago = random.randint(15, 45)
        created_at = now - timedelta(days=created_days_ago)
        due_at = created_at + timedelta(days=15)
        
        status = "OVERDUE" if due_at < now else "PENDING"
        
        invoice = Invoice(
            id=f"inv_B2B_{1000 + i}",
            customer_name=f"{cust['name']} ({'Inc.' if i % 2 == 0 else 'Retail'})",
            customer_email=cust['email'],
            customer_phone=cust['phone'],
            amount=amount,
            status=status,
            created_at=created_at,
            due_at=due_at,
            contact_count=0,
            recovery_campaign_status="ACTIVE" if status == "OVERDUE" else "IDLE"
        )
        db.add(invoice)
        
        # Log ingestion
        audit = AuditLog(
            entity_type="invoice",
            entity_id=invoice.id,
            timestamp=created_at,
            stage="INGESTED",
            action_taken="Invoice Created",
            reasoning="System generated new B2B invoice."
        )
        db.add(audit)

    # 2. Seed 25 Failed Payments (B2C Checkout / Subscriptions)
    for i in range(1, 26):
        cust = random.choice(CUSTOMER_TEMPLATES)
        amount = round(random.uniform(500, 8000), 2)
        fail_code, fail_desc = random.choice(FAILURE_REASONS)
        created_ago = random.randint(1, 48)
        created_at = now - timedelta(hours=created_ago)
        
        payment = Payment(
            id=f"pay_failed_{2000 + i}",
            amount=amount,
            currency="INR",
            status="failed",
            failure_code=fail_code,
            failure_description=fail_desc,
            payment_method=random.choice(["card", "upi", "netbanking"]),
            created_at=created_at,
            recovered_by_agent=False,
            retry_count=0
        )
        db.add(payment)
        
        # Log ingestion
        audit = AuditLog(
            entity_type="payment",
            entity_id=payment.id,
            timestamp=created_at,
            stage="INGESTED",
            action_taken="Payment Failed Event",
            reasoning=f"Payment gateway returned code {fail_code}: {fail_desc}"
        )
        db.add(audit)

    # 3. Seed 10 Checkout Drop-offs (Abandoned Carts)
    for i in range(1, 11):
        cust = random.choice(CUSTOMER_TEMPLATES)
        amount = round(random.uniform(1000, 15000), 2)
        created_ago = random.randint(2, 24)
        created_at = now - timedelta(hours=created_ago)
        
        # Invoices can represent abandoned checkout carts here
        checkout = Invoice(
            id=f"cart_abandon_{3000 + i}",
            customer_name=cust['name'],
            customer_email=cust['email'],
            customer_phone=cust['phone'],
            amount=amount,
            status="PENDING",
            created_at=created_at,
            due_at=created_at + timedelta(days=1),
            contact_count=0,
            recovery_campaign_status="ACTIVE",
            failure_reason="Customer dropped off at the shipping stage."
        )
        db.add(checkout)
        
        audit = AuditLog(
            entity_type="invoice",
            entity_id=checkout.id,
            timestamp=created_at,
            stage="INGESTED",
            action_taken="Checkout Abandoned Event",
            reasoning="Checkout session timed out without completing payment."
        )
        db.add(audit)

    db.commit()
    return 55

def run_step_recovery(db: Session, entity_type: str, entity_id: str) -> dict:
    """Runs a single simulation execution tick for a specific Payment or Invoice."""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    
    if entity_type == "payment":
        payment = db.query(Payment).filter(Payment.id == entity_id).first()
        if not payment or payment.status in ["captured", "refunded"]:
            return {"status": "skipped", "message": "Payment already resolved or missing."}
            
        # 1. Diagnose payment if not yet diagnosed
        latest_audit = db.query(AuditLog).filter(
            AuditLog.entity_type == "payment",
            AuditLog.entity_id == payment.id
        ).order_by(AuditLog.timestamp.desc()).first()
        
        if latest_audit.stage == "INGESTED":
            # Call AI diagnosis
            diag = diagnose_payment_failure(
                payment.id, payment.amount, payment.payment_method,
                payment.failure_code, payment.failure_description, "Valued Customer"
            )
            
            payment.failure_description = f"Diagnosed: {diag['diagnosis']}"
            
            # Log diagnosis
            db.add(AuditLog(
                entity_type="payment",
                entity_id=payment.id,
                stage="DIAGNOSED",
                action_taken=f"Strategy Decided: {diag['recommended_strategy']}",
                reasoning=diag["reasoning"],
                details=json.dumps(diag)
            ))
            db.commit()
            return {"status": "diagnosed", "strategy": diag["recommended_strategy"], "diagnosis": diag["diagnosis"]}
            
        # 2. Execute Strategy
        strategy_audit = db.query(AuditLog).filter(
            AuditLog.entity_type == "payment",
            AuditLog.entity_id == payment.id,
            AuditLog.stage == "DIAGNOSED"
        ).first()
        
        if not strategy_audit:
            return {"status": "skipped"}
            
        diag = json.loads(strategy_audit.details)
        strategy = diag["recommended_strategy"]
        
        if strategy == "SILENT_RETRY":
            # Gateway Health Check (Degradation Routing)
            bank = "HDFC"
            if payment.payment_method == "upi":
                bank = "UPI"
            elif payment.payment_method == "netbanking":
                try:
                    val_id = int(payment.id.split("_")[-1])
                    bank = "SBI" if val_id % 2 != 0 else "ICICI"
                except Exception:
                    bank = "SBI"
            
            from app.gateway import GATEWAY_HEALTH
            if GATEWAY_HEALTH.get(bank, "stable") == "degraded":
                db.add(AuditLog(
                    entity_type="payment",
                    entity_id=payment.id,
                    stage="GATED",
                    action_taken="Silent Retry Deferred (Gateway Degraded)",
                    reasoning=f"Adaptive Routing: Bank Gateway ({bank}) is experiencing service degradation. "
                              f"Silent retry is deferred to prevent transaction decay.",
                    details=f"Gateway: {bank}, Current Status: DEGRADED. Retry deferred."
                ))
                db.commit()
                return {"status": "gated_degraded", "bank": bank, "message": f"Retry held due to degraded {bank} gateway."}

            # Bounded rules checking
            if payment.retry_count >= 2:
                # Stopping rule triggered!
                payment.status = "failed"
                db.add(AuditLog(
                    entity_type="payment",
                    entity_id=payment.id,
                    stage="STOPPED",
                    action_taken="Halted Retries",
                    reasoning="Stopping Rule: Maximum silent retries (2) reached. Escalated to manual support.",
                    details="No further automated money action attempted."
                ))
                db.commit()
                return {"status": "stopped", "message": "Max retry limit reached."}
                
            payment.retry_count += 1
            # Simulate a retry success rate of 55%
            success = random.random() < 0.55
            if success:
                payment.status = "captured"
                payment.recovered_by_agent = True
                db.add(AuditLog(
                    entity_type="payment",
                    entity_id=payment.id,
                    stage="RECOVERED",
                    action_taken="Silent Retry Successful",
                    reasoning=f"Automated gateway retry succeeded on attempt #{payment.retry_count}.",
                    details=f"Gateway captured INR {payment.amount}"
                ))
                db.commit()
                return {"status": "recovered", "amount": payment.amount}
            else:
                db.add(AuditLog(
                    entity_type="payment",
                    entity_id=payment.id,
                    stage="CHASING",
                    action_taken=f"Silent Retry #{payment.retry_count} Failed",
                    reasoning="Bank gateway returned temporary failure. Scheduling next try.",
                    details="Retry failed. Incrementing count."
                ))
                db.commit()
                return {"status": "retry_failed"}
                
        else: # ACTION_REQUIRED_EMAIL or alternative payment
            # Send recovery checkout link via email
            if payment.retry_count >= 3:
                # Stopping rule
                db.add(AuditLog(
                    entity_type="payment",
                    entity_id=payment.id,
                    stage="STOPPED",
                    action_taken="Campaign Halted",
                    reasoning="Stopping Rule: Contact count limit (3 emails) reached without payment. Transferred to collections.",
                    details="Campaign stopped to prevent spam/abuse."
                ))
                db.commit()
                return {"status": "stopped", "message": "Max outreach messages sent."}
                
            payment.retry_count += 1
            comm_data = generate_communication("payment_failed", {"id": payment.id, "amount": payment.amount}, "email", payment.retry_count)
            
            db.add(Communication(
                entity_id=payment.id,
                entity_type="payment",
                channel="email",
                direction="outbound",
                content=comm_data["body"]
            ))
            
            db.add(AuditLog(
                entity_type="payment",
                entity_id=payment.id,
                stage="CHASING",
                action_taken=f"Sent Recovery Email #{payment.retry_count}",
                reasoning=f"Prompted user with checkout link. Strategy: {strategy}. Impact: {comm_data['estimated_impact']}",
                details=comm_data["body"]
            ))
            
            # Simulate a 40% probability customer opens email and pays immediately
            user_pay = random.random() < 0.40
            if user_pay:
                payment.status = "captured"
                payment.recovered_by_agent = True
                db.add(AuditLog(
                    entity_type="payment",
                    entity_id=payment.id,
                    stage="RECOVERED",
                    action_taken="Paid via Checkout Link",
                    reasoning="Customer opened recovery email and completed payment through simulated checkout page.",
                    details=f"Captured INR {payment.amount}."
                ))
                db.commit()
                return {"status": "recovered", "amount": payment.amount}
            else:
                db.commit()
                return {"status": "emailed_waiting"}

    elif entity_type == "invoice":
        invoice = db.query(Invoice).filter(Invoice.id == entity_id).first()
        if not invoice or invoice.status in ["PAID", "RECOVERED"]:
            return {"status": "skipped", "message": "Invoice already paid."}
            
        # If campaign is paused (due to promise-to-pay), skip unless promise date expired
        if invoice.recovery_campaign_status == "PAUSED":
            if invoice.promised_payment_date and invoice.promised_payment_date > now:
                return {"status": "paused", "message": f"Paused until promised date: {invoice.promised_payment_date.strftime('%Y-%m-%d')}"}
            elif invoice.promised_payment_date:
                # Promise expired! Resume and escalate
                db.add(AuditLog(
                    entity_type="invoice",
                    entity_id=invoice.id,
                    stage="CHASING",
                    action_taken="Resumed Campaign (Broken Promise)",
                    reasoning=f"Payment promise date ({invoice.promised_payment_date.strftime('%Y-%m-%d')}) passed without settlement. Escolating tone.",
                    details="Campaign status set back to ACTIVE."
                ))
                invoice.recovery_campaign_status = "ACTIVE"
                invoice.promised_payment_date = None
                
        if invoice.recovery_campaign_status in ["STOPPED_LIMIT", "STOPPED_OPT_OUT"]:
            return {"status": "stopped", "message": f"Campaign terminated: {invoice.recovery_campaign_status}"}

        # Dunning campaign: Send emails up to 3 times
        if invoice.contact_count >= 3:
            # Stopping Rule
            invoice.recovery_campaign_status = "STOPPED_LIMIT"
            db.add(AuditLog(
                entity_type="invoice",
                entity_id=invoice.id,
                stage="STOPPED",
                action_taken="Campaign Halted",
                reasoning="Stopping Rule: Maximum contacts (3) reached. Manual escalation triggered.",
                details="Compliant policy prevents sending further reminders to this business contact."
            ))
            db.commit()
            return {"status": "stopped", "message": "Max outreach reached."}
            
        # Send Chase Email
        invoice.contact_count += 1
        invoice.last_contacted_at = now
        invoice.recovery_campaign_status = "ACTIVE"
        
        # Generate context info
        details_str = "Abandoned checkout drop-off" if "abandon" in invoice.id else "B2B Accounts Receivable"
        comm_data = generate_communication("invoice", {"id": invoice.id, "amount": invoice.amount, "customer_name": invoice.customer_name, "details": details_str}, "email", invoice.contact_count)
        
        db.add(Communication(
            entity_id=invoice.id,
            entity_type="invoice",
            channel="email",
            direction="outbound",
            content=comm_data["body"]
        ))
        
        db.add(AuditLog(
            entity_type="invoice",
            entity_id=invoice.id,
            stage="CHASING",
            action_taken=f"Sent Invoice Chase #{invoice.contact_count}",
            reasoning=f"Invoiced buyer. Tone sequence match: {invoice.contact_count}. Estimated impact: {comm_data['estimated_impact']}",
            details=comm_data["body"]
        ))
        db.commit()
        
        # Simulate Customer action:
        # 30% pay immediately, 35% reply with promise/dispute/optout, 35% ignore.
        outcome = random.random()
        if outcome < 0.30:
            invoice.status = "RECOVERED"
            invoice.recovery_campaign_status = "COMPLETED"
            db.add(AuditLog(
                entity_type="invoice",
                entity_id=invoice.id,
                stage="RECOVERED",
                action_taken="Invoice Paid",
                reasoning="Customer completed full payment of overdue invoice via checkout link.",
                details=f"Recovered INR {invoice.amount}."
            ))
            db.commit()
            return {"status": "recovered", "amount": invoice.amount}
            
        elif outcome < 0.65:
            # Simulate a reply from the customer
            reply_text = random.choice(MOCK_REPLIES)
            db.add(Communication(
                entity_id=invoice.id,
                entity_type="invoice",
                channel="email",
                direction="inbound",
                content=reply_text
            ))
            
            # AI Parsers response
            parse_res = parse_customer_reply(reply_text, {"id": invoice.id, "amount": invoice.amount, "due_at": invoice.due_at})
            intent = parse_res["intent"]
            
            db.add(AuditLog(
                entity_type="invoice",
                entity_id=invoice.id,
                stage="CHASING",
                action_taken=f"Customer Replied (Parsed: {intent})",
                reasoning=f"AI parsed customer reply. Reason: {parse_res['action_required']}",
                details=f"Reply: '{reply_text}'\nSuggested reply: '{parse_res['suggested_reply']}'"
            ))
            
            # Handle reply actions
            if intent == "OPT_OUT":
                invoice.recovery_campaign_status = "STOPPED_OPT_OUT"
                db.add(AuditLog(
                    entity_type="invoice",
                    entity_id=invoice.id,
                    stage="STOPPED",
                    action_taken="Campaign Cancelled (Opt-Out)",
                    reasoning="Compliant Stopping Rule: Customer explicitly opted out / requested removal.",
                    details="Campaign state changed to STOPPED_OPT_OUT."
                ))
            elif intent == "DISPUTE":
                invoice.recovery_campaign_status = "PAUSED"
                invoice.status = "FAILED" # Mark disputed/failed for dashboard highlights
                db.add(AuditLog(
                    entity_type="invoice",
                    entity_id=invoice.id,
                    stage="STOPPED",
                    action_taken="Campaign Paused (Disputed)",
                    reasoning="Stopping Rule: Customer disputed invoice. Escalating to human customer operations.",
                    details="Campaign paused to prevent friction during dispute resolution."
                ))
            elif intent == "PROMISE_TO_PAY" and parse_res["promised_date"]:
                invoice.recovery_campaign_status = "PAUSED"
                promised_dt = datetime.strptime(parse_res["promised_date"], "%Y-%m-%d")
                invoice.promised_payment_date = promised_dt
                db.add(AuditLog(
                    entity_type="invoice",
                    entity_id=invoice.id,
                    stage="CHASING",
                    action_taken="Campaign Paused (Promise Shared)",
                    reasoning=f"Customer promised to pay on {parse_res['promised_date']}. Pausing reminders until then.",
                    details=f"Payment date promise recorded: {parse_res['promised_date']}"
                ))
                
            db.commit()
            return {"status": "reply_received", "intent": intent}
            
        else:
            db.commit()
            return {"status": "ignored"}
            
    return {"status": "unknown"}

def run_entire_batch(db: Session) -> dict:
    """Executes multiple ticks of the simulation for all unresolved records until settled or stopped."""
    # Seed new data first if DB is empty
    count = db.query(Payment).count() + db.query(Invoice).count()
    if count == 0:
        seed_synthetic_data(db)
        
    payments = db.query(Payment).filter(Payment.status == "failed").all()
    invoices = db.query(Invoice).filter(Invoice.status.in_(["PENDING", "OVERDUE"])).all()
    
    total_records = len(payments) + len(invoices)
    recovered_amount = 0.0
    recovered_count = 0
    stopped_count = 0
    active_count = 0
    exceptions = []

    # Run up to 4 dunning/retry execution rounds (simulating 4 virtual weeks/days)
    for _ in range(4):
        for pay in payments:
            if pay.status == "captured" or pay.retry_count >= 3:
                continue
            res = run_step_recovery(db, "payment", pay.id)
            if res.get("status") == "recovered":
                recovered_amount += res["amount"]
                recovered_count += 1
            elif res.get("status") == "stopped":
                stopped_count += 1
                exceptions.append(f"Payment {pay.id} stopped: {res.get('message')}")
                
        for inv in invoices:
            if inv.status in ["PAID", "RECOVERED"] or inv.recovery_campaign_status in ["STOPPED_LIMIT", "STOPPED_OPT_OUT"]:
                continue
            res = run_step_recovery(db, "invoice", inv.id)
            if res.get("status") == "recovered":
                recovered_amount += res["amount"]
                recovered_count += 1
            elif res.get("status") == "stopped":
                stopped_count += 1
                exceptions.append(f"Invoice {inv.id} stopped: {res.get('message')}")
                
    # Recalculate remaining active items
    remaining_payments = db.query(Payment).filter(Payment.status == "failed").count()
    remaining_invoices = db.query(Invoice).filter(Invoice.status.in_(["PENDING", "OVERDUE"]), ~Invoice.recovery_campaign_status.in_(["STOPPED_LIMIT", "STOPPED_OPT_OUT"])).count()
    active_count = remaining_payments + remaining_invoices
    
    # Calculate recovery rate
    recovery_rate = (recovered_count / total_records * 100) if total_records > 0 else 0
    
    return {
        "total_records": total_records,
        "recovered_count": recovered_count,
        "recovered_amount": round(recovered_amount, 2),
        "stopped_count": stopped_count,
        "active_count": active_count,
        "recovery_rate": round(recovery_rate, 2),
        "exceptions": exceptions
    }
