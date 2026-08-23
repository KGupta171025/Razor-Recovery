import os
from fastapi import FastAPI, Depends, HTTPException, Body, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from datetime import datetime, timezone, timedelta
from pydantic import BaseModel

from contextlib import asynccontextmanager

from app.database import get_db, init_db
from app.models import Invoice, Payment, AuditLog, Communication
import app.simulator as simulator

# Modern Lifespan Handler for Startup/Shutdown Events
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    db = next(get_db())
    if db.query(Invoice).count() == 0 and db.query(Payment).count() == 0:
        simulator.seed_synthetic_data(db)
    yield

app = FastAPI(title="RazorRecovery AI - Developer Portal", lifespan=lifespan)

# Secure CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8000", "http://localhost:8000"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# Secure Response Headers Middleware
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; "
        "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; "
        "img-src 'self' data:; "
        "connect-src 'self';"
    )
    return response

# Request Payload Size Limit Middleware to prevent DoS (memory exhaustion)
@app.middleware("http")
async def limit_payload_size(request: Request, call_next):
    if request.method in ["POST", "PUT"]:
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                size_bytes = int(content_length)
                if size_bytes > 256 * 1024:  # 256 KB Limit
                    return JSONResponse(
                        content={"detail": "Payload Too Large (256 KB Limit Exceeded)"},
                        status_code=413
                    )
            except ValueError:
                pass
    return await call_next(request)

# Pydantic Schemas for Request Validation
class GatewayToggleRequest(BaseModel):
    bank: str

class OverrideRequest(BaseModel):
    override: str

class DisputeActionRequest(BaseModel):
    entity_id: str
    action: str

class StepRequest(BaseModel):
    entity_type: str
    entity_id: str

class PaymentMockRequest(BaseModel):
    entity_type: str
    entity_id: str

# API: Seed/Reset Database
@app.post("/api/seed")
def seed_db(db: Session = Depends(get_db)):
    count = simulator.seed_synthetic_data(db)
    return {"status": "success", "message": f"Database successfully reset and seeded with {count} records."}

# API: Execute Simulation Step
@app.post("/api/step")
def step_recovery(req: StepRequest, db: Session = Depends(get_db)):
    res = simulator.run_step_recovery(db, req.entity_type, req.entity_id)
    return res

# API: Run Full Batch (55 records)
@app.post("/api/run-batch")
def run_batch(db: Session = Depends(get_db)):
    res = simulator.run_entire_batch(db)
    return res

# API: Fetch Metrics Summary
@app.get("/api/metrics")
def get_metrics(db: Session = Depends(get_db)):
    # Total items
    total_invoices = db.query(Invoice).all()
    total_payments = db.query(Payment).all()
    
    total_at_risk = sum(i.amount for i in total_invoices) + sum(p.amount for p in total_payments)
    
    recovered_invoices = sum(i.amount for i in total_invoices if i.status == "RECOVERED")
    recovered_payments = sum(p.amount for p in total_payments if p.status == "captured" and p.recovered_by_agent)
    total_recovered = recovered_invoices + recovered_payments
    
    recovered_count = len([i for i in total_invoices if i.status == "RECOVERED"]) + len([p for p in total_payments if p.status == "captured" and p.recovered_by_agent])
    total_count = len(total_invoices) + len(total_payments)
    
    success_rate = (recovered_count / total_count * 100) if total_count > 0 else 0
    
    # Active Dunning
    active_invoices = db.query(Invoice).filter(Invoice.status.in_(["PENDING", "OVERDUE"]), ~Invoice.recovery_campaign_status.in_(["STOPPED_LIMIT", "STOPPED_OPT_OUT"])).count()
    active_payments = db.query(Payment).filter(Payment.status == "failed", Payment.retry_count < 3).count()
    active_cases = active_invoices + active_payments
    
    # Gated / Stopped cases
    stopped_invoices = db.query(Invoice).filter(Invoice.recovery_campaign_status.in_(["STOPPED_LIMIT", "STOPPED_OPT_OUT"])).count()
    stopped_payments = db.query(Payment).filter(Payment.status == "failed", Payment.retry_count >= 3).count()
    stopped_cases = stopped_invoices + stopped_payments
    
    # Disputed cases
    disputed_cases = db.query(Invoice).filter(Invoice.status == "FAILED", Invoice.recovery_campaign_status == "PAUSED").count()

    import app.gateway as gateway
    return {
        "total_at_risk": round(total_at_risk, 2),
        "total_recovered": round(total_recovered, 2),
        "recovery_rate": round(success_rate, 2),
        "active_cases": active_cases,
        "stopped_cases": stopped_cases,
        "disputed_cases": disputed_cases,
        "simulation_override": gateway.SIMULATION_OVERRIDE
    }

# API: Fetch Pipelines
@app.get("/api/pipelines")
def get_pipelines(db: Session = Depends(get_db)):
    invoices = db.query(Invoice).all()
    payments = db.query(Payment).all()
    
    # Map to dashboard formats
    pipeline = []
    
    for i in invoices:
        # Determine visual stage on board
        stage = "INGESTED"
        if i.status == "RECOVERED":
            stage = "RECOVERED"
        elif i.recovery_campaign_status in ["STOPPED_LIMIT", "STOPPED_OPT_OUT"]:
            stage = "STOPPED"
        elif i.recovery_campaign_status == "PAUSED" and i.status == "FAILED":
            stage = "DISPUTED"
        elif i.recovery_campaign_status == "PAUSED":
            stage = "GATED"
        elif i.contact_count > 0:
            stage = "CHASING"
        elif i.failure_reason:
            stage = "DIAGNOSED"
            
        pipeline.append({
            "id": i.id,
            "type": "invoice",
            "name": i.customer_name,
            "email": i.customer_email,
            "amount": i.amount,
            "status": i.status,
            "stage": stage,
            "contact_count": i.contact_count,
            "reason": i.failure_reason or "B2B Overdue Invoice"
        })
        
    for p in payments:
        stage = "INGESTED"
        if p.status == "captured":
            stage = "RECOVERED"
        elif p.retry_count >= 3:
            stage = "STOPPED"
        elif p.retry_count > 0:
            stage = "CHASING"
        elif "Diagnosed" in (p.failure_description or ""):
            stage = "DIAGNOSED"
            
        pipeline.append({
            "id": p.id,
            "type": "payment",
            "name": f"Customer ({p.payment_method.upper()})",
            "email": "customer@example.com",
            "amount": p.amount,
            "status": p.status,
            "stage": stage,
            "contact_count": p.retry_count,
            "reason": p.failure_description or f"Failed {p.payment_method.upper()}"
        })
        
    return pipeline

# API: Audit Trail
@app.get("/api/audit-trail/{entity_id}")
def get_audit_trail(entity_id: str, db: Session = Depends(get_db)):
    logs = db.query(AuditLog).filter(AuditLog.entity_id == entity_id).order_by(AuditLog.timestamp.asc()).all()
    comms = db.query(Communication).filter(Communication.entity_id == entity_id).order_by(Communication.timestamp.asc()).all()
    
    logs_json = []
    for l in logs:
        logs_json.append({
            "timestamp": l.timestamp.strftime("%Y-%m-%d %H:%M:%S"),
            "stage": l.stage,
            "action_taken": l.action_taken,
            "reasoning": l.reasoning,
            "details": l.details
        })
        
    comms_json = []
    for c in comms:
        comms_json.append({
            "timestamp": c.timestamp.strftime("%Y-%m-%d %H:%M:%S"),
            "channel": c.channel,
            "direction": c.direction,
            "content": c.content
        })
        
    return {"logs": logs_json, "communications": comms_json}

# API: Manual / Checkout Mock Payment Success
@app.post("/api/pay-mock")
def pay_mock(req: PaymentMockRequest, db: Session = Depends(get_db)):
    entity_id = req.entity_id
    if "pay_" in entity_id:
        payment = db.query(Payment).filter(Payment.id == entity_id).first()
        if not payment:
            raise HTTPException(status_code=404, detail="Payment not found")
        payment.status = "captured"
        payment.recovered_by_agent = True
        
        db.add(AuditLog(
            entity_type="payment",
            entity_id=payment.id,
            stage="RECOVERED",
            action_taken="Mock Checkout Payment Successful",
            reasoning="Customer re-submitted correct OTP via simulated Razorpay Checkout modal.",
            details=f"Captured INR {payment.amount}"
        ))
        db.commit()
        return {"status": "success", "message": "Payment captured."}
    else:
        invoice = db.query(Invoice).filter(Invoice.id == entity_id).first()
        if not invoice:
            raise HTTPException(status_code=404, detail="Invoice not found")
        invoice.status = "RECOVERED"
        invoice.recovery_campaign_status = "COMPLETED"
        
        db.add(AuditLog(
            entity_type="invoice",
            entity_id=invoice.id,
            stage="RECOVERED",
            action_taken="Invoice Paid",
            reasoning="Customer completed invoice settlement through the checkout portal.",
            details=f"Recovered INR {invoice.amount}"
        ))
        db.commit()
        return {"status": "success", "message": "Invoice paid."}

# API: Get Gateway Health
@app.get("/api/gateway-health")
def get_gateway_health():
    from app.gateway import GATEWAY_HEALTH
    return GATEWAY_HEALTH

# API: Toggle Gateway Health
@app.post("/api/gateway-health/toggle")
def toggle_gateway_health(req: GatewayToggleRequest):
    from app.gateway import GATEWAY_HEALTH
    bank = req.bank
    if bank not in GATEWAY_HEALTH:
        raise HTTPException(status_code=400, detail="Invalid bank gateway")
    
    current = GATEWAY_HEALTH[bank]
    GATEWAY_HEALTH[bank] = "degraded" if current == "stable" else "stable"
    return {"status": "success", "bank": bank, "health": GATEWAY_HEALTH[bank]}

# API: Set Simulation Override
@app.post("/api/simulation/override")
def set_simulation_override(req: OverrideRequest):
    import app.gateway as gateway
    override = req.override
    if override not in ["normal", "induce_gateway_failure", "customer_opt_out", "dispute_trigger"]:
        raise HTTPException(status_code=400, detail="Invalid override state")
    gateway.SIMULATION_OVERRIDE = override
    
    # Apply override effects immediately
    if override == "induce_gateway_failure":
        for b in gateway.GATEWAY_HEALTH:
            gateway.GATEWAY_HEALTH[b] = "degraded"
    elif override == "normal":
        for b in gateway.GATEWAY_HEALTH:
            gateway.GATEWAY_HEALTH[b] = "stable"
            
    return {"status": "success", "override": override, "gateway_health": gateway.GATEWAY_HEALTH}

# API: Human-in-the-Loop Dispute/Promise Actions
@app.post("/api/dispute-action")
def dispute_action(req: DisputeActionRequest, db: Session = Depends(get_db)):
    entity_id = req.entity_id
    action = req.action
    invoice = db.query(Invoice).filter(Invoice.id == entity_id).first()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
        
    if action == "REFUND_RESOLVE":
        invoice.status = "CANCELLED"
        invoice.recovery_campaign_status = "COMPLETED"
        db.add(AuditLog(
            entity_type="invoice",
            entity_id=invoice.id,
            stage="STOPPED",
            action_taken="Resolved & Cancelled via HITL",
            reasoning="Merchant resolved dispute manually. Cancelled further recovery campaign.",
            details="Dispute settled by issuing refund/cancellation."
        ))
        db.commit()
        return {"status": "success", "message": "Dispute resolved and cancelled."}
        
    elif action == "RESCHEDULE_PROMISE":
        from datetime import timedelta
        # Extend promise date by 7 days
        new_date = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=7)
        invoice.promised_payment_date = new_date
        invoice.recovery_campaign_status = "PAUSED"
        db.add(AuditLog(
            entity_type="invoice",
            entity_id=invoice.id,
            stage="GATED",
            action_taken="Promise Deferral Extended",
            reasoning="Merchant approved extending promise-to-pay date by 7 days.",
            details=f"New promise date set to: {new_date.strftime('%Y-%m-%d')}"
        ))
        db.commit()
        return {"status": "success", "message": f"Promise date extended to {new_date.strftime('%Y-%m-%d')}."}
        
    raise HTTPException(status_code=400, detail="Invalid action")

# API: Verify Cryptographic Ledger Integrity
@app.get("/api/security/verify-ledger")
def verify_ledger(db: Session = Depends(get_db)):
    import hashlib
    logs = db.query(AuditLog).order_by(AuditLog.id.asc()).all()
    
    verified_count = 0
    prev_hash = "GENESIS_HASH"
    
    for log in logs:
        # Re-calculate hash using database properties
        content_str = (
            f"{log.entity_type}|{log.entity_id}|{log.stage}|"
            f"{log.action_taken}|{log.reasoning or ''}|"
            f"{log.details or ''}|{prev_hash}"
        )
        expected_hash = hashlib.sha256(content_str.encode('utf-8')).hexdigest()
        
        if log.hash_signature != expected_hash:
            raise HTTPException(
                status_code=500,
                detail=f"Ledger Integrity Compromised! Audit Log ID {log.id} hash signature mismatch. "
                       f"Expected: {expected_hash}, Actual: {log.hash_signature}"
            )
        
        prev_hash = log.hash_signature
        verified_count += 1
        
    return {
        "status": "secured",
        "verified_records_count": verified_count,
        "tampered": False,
        "message": "Cryptographic hash chain validated successfully. Audit ledger is intact and untampered."
    }

# API: Get Hinglish Voice Script
@app.get("/api/voice-script/{entity_id}")
def get_voice_script(entity_id: str, db: Session = Depends(get_db)):
    from app.agent import generate_hinglish_voice_script
    
    amount = 0.0
    customer_name = "Customer"
    contact_count = 1
    
    if "pay_" in entity_id:
        payment = db.query(Payment).filter(Payment.id == entity_id).first()
        if payment:
            amount = payment.amount
            customer_name = f"Customer ({payment.payment_method.upper()})"
            contact_count = max(1, payment.retry_count)
    else:
        invoice = db.query(Invoice).filter(Invoice.id == entity_id).first()
        if invoice:
            amount = invoice.amount
            customer_name = invoice.customer_name
            contact_count = max(1, invoice.contact_count)
            
    res = generate_hinglish_voice_script(
        {"id": entity_id, "amount": amount, "customer_name": customer_name},
        contact_count
    )
    return res

# Checkout Page Interface
@app.get("/checkout/{entity_id}", response_class=HTMLResponse)
def render_checkout(entity_id: str, db: Session = Depends(get_db)):
    amount = 0.0
    name = "Checkout Invoice"
    
    if "pay_" in entity_id:
        payment = db.query(Payment).filter(Payment.id == entity_id).first()
        if payment:
            amount = payment.amount
            name = f"Failed Payment Retry ({payment.id})"
    else:
        invoice = db.query(Invoice).filter(Invoice.id == entity_id).first()
        if invoice:
            amount = invoice.amount
            name = invoice.customer_name
            
    html_content = f"""
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Razorpay Secure Checkout</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
            * {{
                box-sizing: border-box;
                margin: 0;
                padding: 0;
                font-family: 'Inter', sans-serif;
            }}
            body {{
                background-color: #0f172a;
                color: #f1f5f9;
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
            }}
            .card {{
                background: rgba(30, 41, 59, 0.7);
                border: 1px solid rgba(255, 255, 255, 0.1);
                backdrop-filter: blur(16px);
                border-radius: 16px;
                padding: 32px;
                width: 100%;
                max-width: 450px;
                box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
            }}
            .header {{
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 24px;
                padding-bottom: 16px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            }}
            .logo {{
                font-size: 20px;
                font-weight: 700;
                color: #3b82f6;
                display: flex;
                align-items: center;
                gap: 8px;
            }}
            .logo span {{
                color: #f1f5f9;
            }}
            .amount {{
                font-size: 28px;
                font-weight: 700;
                color: #10b981;
            }}
            .details {{
                margin-bottom: 24px;
            }}
            .details-row {{
                display: flex;
                justify-content: space-between;
                margin-bottom: 8px;
                font-size: 14px;
            }}
            .details-label {{
                color: #94a3b8;
            }}
            .pay-btn {{
                background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
                color: white;
                border: none;
                border-radius: 8px;
                padding: 14px 20px;
                font-size: 16px;
                font-weight: 600;
                width: 100%;
                cursor: pointer;
                transition: transform 0.2s, opacity 0.2s;
                box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
            }}
            .pay-btn:hover {{
                transform: translateY(-1px);
                opacity: 0.95;
            }}
            .pay-btn:active {{
                transform: translateY(1px);
            }}
            .footer {{
                text-align: center;
                font-size: 12px;
                color: #64748b;
                margin-top: 24px;
            }}
            .badge {{
                display: inline-block;
                background-color: #1e293b;
                color: #3b82f6;
                border: 1px solid rgba(59, 130, 246, 0.3);
                padding: 4px 10px;
                border-radius: 9999px;
                font-size: 12px;
                font-weight: 500;
            }}
            .success-container {{
                display: none;
                text-align: center;
                padding: 16px 0;
            }}
            .success-icon {{
                font-size: 48px;
                color: #10b981;
                margin-bottom: 16px;
            }}
        </style>
    </head>
    <body>
        <div class="card" id="checkout-card">
            <div class="header">
                <div class="logo">
                    Razorpay <span>Checkout</span>
                </div>
                <div class="badge">TEST MODE</div>
            </div>
            
            <div class="details">
                <div class="details-row">
                    <span class="details-label">Paying To:</span>
                    <span>Razorpay Recovery Merchant</span>
                </div>
                <div class="details-row">
                    <span class="details-label">Reference ID:</span>
                    <span>{entity_id}</span>
                </div>
                <div class="details-row">
                    <span class="details-label">Customer:</span>
                    <span>{name}</span>
                </div>
            </div>
            
            <div style="text-align: center; margin-bottom: 32px;">
                <div class="details-label" style="font-size: 14px; margin-bottom: 4px;">Amount Due</div>
                <div class="amount">₹{amount:,.2f}</div>
            </div>
            
            <button class="pay-btn" id="pay-button" onclick="executePayment()">Pay Securely</button>
            
            <div class="footer">
                🔒 Secured by Razorpay. 256-bit encryption.
            </div>
        </div>

        <div class="card" id="success-card" style="display: none; text-align: center;">
            <div class="success-icon">✓</div>
            <h2 style="font-size: 24px; font-weight: 600; margin-bottom: 8px; color: #10b981;">Payment Successful</h2>
            <p style="color: #94a3b8; font-size: 14px; margin-bottom: 24px;">Thank you! Your payment of ₹{amount:,.2f} has been recovered successfully.</p>
            <button class="pay-btn" onclick="window.close()">Close Window</button>
        </div>

        <script>
            function executePayment() {{
                const btn = document.getElementById("pay-button");
                btn.disabled = true;
                btn.innerText = "Processing...";
                
                fetch('/api/pay-mock', {{
                    method: 'POST',
                    headers: {{
                        'Content-Type': 'application/json'
                    }},
                    body: JSON.stringify({{ entity_id: '{entity_id}' }})
                }})
                .then(res => res.json())
                .then(data => {{
                    if (data.status === "success") {{
                        document.getElementById("checkout-card").style.display = "none";
                        document.getElementById("success-card").style.display = "block";
                    }} else {{
                        alert("Error processing payment: " + data.message);
                        btn.disabled = false;
                        btn.innerText = "Pay Securely";
                    }}
                }})
                .catch(err => {{
                    console.error(err);
                    alert("Network error processing payment.");
                    btn.disabled = false;
                    btn.innerText = "Pay Securely";
                }});
            }}
        </script>
    </body>
    </html>
    """
    return html_content

# Serve root dashboard
@app.get("/", response_class=FileResponse)
def get_dashboard():
    return FileResponse("app/static/index.html")

# Mount Static Files
app.mount("/", StaticFiles(directory="app/static"), name="static")
