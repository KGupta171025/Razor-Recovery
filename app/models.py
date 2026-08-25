from datetime import datetime, timezone
import hashlib
from sqlalchemy import Column, String, Float, DateTime, Integer, Boolean, ForeignKey, event, text, CheckConstraint
from app.database import Base, engine

def utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)

class Invoice(Base):
    __tablename__ = "invoices"
    __table_args__ = (CheckConstraint('amount >= 0', name='check_invoice_amount_positive'),)

    id = Column(String, primary_key=True, index=True) # e.g. inv_12345
    customer_name = Column(String, nullable=False)
    customer_email = Column(String, nullable=False)
    customer_phone = Column(String, nullable=False)
    amount = Column(Float, nullable=False)
    status = Column(String, default="PENDING") # PENDING, OVERDUE, PAID, RECOVERED, FAILED
    created_at = Column(DateTime, default=utc_now)
    due_at = Column(DateTime, nullable=False)
    last_contacted_at = Column(DateTime, nullable=True)
    contact_count = Column(Integer, default=0)
    recovery_campaign_status = Column(String, default="IDLE") # IDLE, ACTIVE, PAUSED, STOPPED_LIMIT, STOPPED_OPT_OUT, COMPLETED
    promised_payment_date = Column(DateTime, nullable=True)
    failure_reason = Column(String, nullable=True) # Set when failure/overdue analysis is done

class Payment(Base):
    __tablename__ = "payments"
    __table_args__ = (CheckConstraint('amount >= 0', name='check_payment_amount_positive'),)

    id = Column(String, primary_key=True, index=True) # e.g. pay_12345
    invoice_id = Column(String, ForeignKey("invoices.id"), nullable=True)
    amount = Column(Float, nullable=False)
    currency = Column(String, default="INR")
    status = Column(String, default="created") # created, authorized, captured, failed
    failure_code = Column(String, nullable=True)
    failure_description = Column(String, nullable=True)
    payment_method = Column(String, nullable=True) # card, upi, netbanking
    created_at = Column(DateTime, default=utc_now)
    recovered_by_agent = Column(Boolean, default=False)
    retry_count = Column(Integer, default=0)

class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    entity_type = Column(String, nullable=False) # invoice, payment
    entity_id = Column(String, nullable=False)
    timestamp = Column(DateTime, default=utc_now)
    stage = Column(String, nullable=False) # INGESTED, DIAGNOSED, CHASING, RECOVERED, GATED, STOPPED
    action_taken = Column(String, nullable=False) # e.g. "Sent Email", "Silent Retry Scheduled"
    reasoning = Column(String, nullable=True) # LLM Reasoning or rule evaluation
    details = Column(String, nullable=True) # Additional details (e.g. Email body, API response)
    hash_signature = Column(String, nullable=True) # Cryptographic hash link for tamper-proofing

class Communication(Base):
    __tablename__ = "communications"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    entity_id = Column(String, nullable=False) # e.g. inv_12345 or pay_12345
    entity_type = Column(String, nullable=False) # invoice, payment
    channel = Column(String, nullable=False) # email, sms, voice
    direction = Column(String, nullable=False) # outbound, inbound
    content = Column(String, nullable=False)
    timestamp = Column(DateTime, default=utc_now)

# Reset signature transaction-local cache whenever a new transaction begins on a connection
@event.listens_for(engine, "begin")
def reset_audit_hash_on_begin(conn):
    conn.info["latest_audit_hash"] = None

# aspect-oriented cryptographic signing hook on AuditLog table insertion
@event.listens_for(AuditLog, "before_insert")
def sign_audit_log(mapper, connection, target):
    # Check if we already have a running chain in the transaction cache
    prev_hash = connection.info.get("latest_audit_hash")
    
    if prev_hash is None:
        # If cache is empty, query the database directly to fetch the previous record's signature
        cursor = connection.execute(
            text("SELECT hash_signature FROM audit_logs ORDER BY id DESC LIMIT 1")
        )
        row = cursor.fetchone()
        prev_hash = row[0] if (row and row[0]) else "GENESIS_HASH"
    
    # Calculate SHA-256 over fields + previous signature
    content_str = (
        f"{target.entity_type}|{target.entity_id}|{target.stage}|"
        f"{target.action_taken}|{target.reasoning or ''}|"
        f"{target.details or ''}|{prev_hash}"
    )
    target.hash_signature = hashlib.sha256(content_str.encode('utf-8')).hexdigest()
    
    # Update transaction cache for subsequent inserts in this transaction
    connection.info["latest_audit_hash"] = target.hash_signature

