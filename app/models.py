from datetime import datetime, timezone
from sqlalchemy import Column, String, Float, DateTime, Integer, Boolean, ForeignKey
from app.database import Base

def utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)

class Invoice(Base):
    __tablename__ = "invoices"

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

class Communication(Base):
    __tablename__ = "communications"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    entity_id = Column(String, nullable=False) # e.g. inv_12345 or pay_12345
    entity_type = Column(String, nullable=False) # invoice, payment
    channel = Column(String, nullable=False) # email, sms, voice
    direction = Column(String, nullable=False) # outbound, inbound
    content = Column(String, nullable=False)
    timestamp = Column(DateTime, default=utc_now)
