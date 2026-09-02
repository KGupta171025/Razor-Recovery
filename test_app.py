import os
import unittest
from datetime import datetime, timezone, timedelta
from sqlalchemy.orm import Session
from app.database import engine, SessionLocal, init_db, Base
from app.models import Invoice, Payment, AuditLog, Communication
import app.simulator as simulator

class TestRazorRecovery(unittest.TestCase):
    
    @classmethod
    def setUpClass(cls):
        # Force database schema drop to compile new CheckConstraints
        Base.metadata.drop_all(bind=engine)
        init_db()
        cls.db = SessionLocal()
        
    @classmethod
    def tearDownClass(cls):
        cls.db.close()
        engine.dispose()
        # Clean up database file after test
        if os.path.exists("./razorrecovery_backup.db"):
            try:
                os.remove("./razorrecovery_backup.db")
            except Exception:
                pass

    def test_01_seeding(self):
        """Test that the 55 synthetic records seed correctly."""
        count = simulator.seed_synthetic_data(self.db)
        self.assertEqual(count, 55, "Should seed exactly 55 records")
        
        # Verify counts in DB
        invoice_count = self.db.query(Invoice).count()
        payment_count = self.db.query(Payment).count()
        
        # Invoices: 20 overdue/pending + 10 abandoned carts = 30 invoices
        # Payments: 25 failed payments
        self.assertEqual(invoice_count, 30)
        self.assertEqual(payment_count, 25)
        
        # Verify audit logs created
        audit_count = self.db.query(AuditLog).count()
        self.assertEqual(audit_count, 55)

    def test_02_step_recovery(self):
        """Test running a single recovery step on a payment failure."""
        # Find an ingested payment
        payment = self.db.query(Payment).filter(Payment.status == "failed").first()
        self.assertIsNotNone(payment)
        
        # Execute first step (Diagnosis)
        res = simulator.run_step_recovery(self.db, "payment", payment.id)
        self.assertEqual(res["status"], "diagnosed")
        self.assertIn("strategy", res)
        
        # Verify Audit Log reflects diagnosis
        latest_audit = self.db.query(AuditLog).filter(
            AuditLog.entity_type == "payment",
            AuditLog.entity_id == payment.id
        ).order_by(AuditLog.timestamp.desc()).first()
        
        self.assertEqual(latest_audit.stage, "DIAGNOSED")
        self.assertIn("Strategy Decided", latest_audit.action_taken)

    def test_03_batch_recovery(self):
        """Test running the full batch recovery simulator."""
        # Reset and seed fresh
        simulator.seed_synthetic_data(self.db)
        
        # Run entire batch
        report = simulator.run_entire_batch(self.db)
        
        self.assertIn("total_records", report)
        self.assertIn("recovered_count", report)
        self.assertIn("recovered_amount", report)
        self.assertIn("recovery_rate", report)
        self.assertIn("exceptions", report)
        
        self.assertEqual(report["total_records"], 55)
        self.assertGreater(report["recovered_count"], 0)
        self.assertGreater(report["recovered_amount"], 0)
        
        print("\n=== Simulation Batch Report ===")
        print(f"Total Records: {report['total_records']}")
        print(f"Recovered Count: {report['recovered_count']}")
        print(f"Recovered Amount: INR {report['recovered_amount']:,}")
        print(f"Success Recovery Rate: {report['recovery_rate']}%")
        print(f"Exceptions (Unresolved): {report['stopped_count']}")
        print("===============================\n")

    def test_04_gateway_degradation(self):
        """Test that retry is deferred when a gateway is degraded."""
        from app.gateway import GATEWAY_HEALTH
        
        # Reset and seed fresh
        simulator.seed_synthetic_data(self.db)
        
        # Set SBI to degraded
        GATEWAY_HEALTH["SBI"] = "degraded"
        
        # Create a dedicated SBI netbanking test payment
        from datetime import datetime, timezone
        
        # Delete one row to make space if needed
        any_payment = self.db.query(Payment).first()
        if any_payment:
            self.db.delete(any_payment)
            self.db.commit()
            
        sbi_payment = Payment(
            id="pay_failed_9999", # Odd ID suffix -> routes to SBI netbanking
            amount=1500.00,
            currency="INR",
            status="failed",
            failure_code="INSUFFICIENT_FUNDS",
            payment_method="netbanking",
            created_at=datetime.now(timezone.utc).replace(tzinfo=None)
        )
        self.db.add(sbi_payment)
        
        audit = AuditLog(
            entity_type="payment",
            entity_id=sbi_payment.id,
            timestamp=sbi_payment.created_at,
            stage="INGESTED",
            action_taken="Payment Failed Event",
            reasoning="Gateway error simulated for SBI netbanking."
        )
        self.db.add(audit)
        self.db.commit()
        
        # Step 1: Ingestion to Diagnosis
        res_diag = simulator.run_step_recovery(self.db, "payment", sbi_payment.id)
        
        # Step 2: Attempt retry while SBI is degraded
        res_retry = simulator.run_step_recovery(self.db, "payment", sbi_payment.id)
        self.assertEqual(res_retry["status"], "gated_degraded")
        self.assertEqual(res_retry["bank"], "SBI")
        
        # Verify Audit Log
        latest_audit = self.db.query(AuditLog).filter(
            AuditLog.entity_type == "payment",
            AuditLog.entity_id == sbi_payment.id
        ).order_by(AuditLog.timestamp.desc()).first()
        self.assertEqual(latest_audit.stage, "GATED")
        self.assertIn("Silent Retry Deferred", latest_audit.action_taken)
        
        # Restore SBI
        GATEWAY_HEALTH["SBI"] = "stable"

    def test_05_simulation_overrides(self):
        """Test that customer opt-out and dispute overrides trigger policy rules."""
        import app.gateway as gateway
        
        # Reset and seed fresh
        simulator.seed_synthetic_data(self.db)
        
        # Find any B2C checkouts/invoice
        invoice = self.db.query(Invoice).first()
        self.assertIsNotNone(invoice)
        
        # Force override state to customer_opt_out
        gateway.SIMULATION_OVERRIDE = "customer_opt_out"
        
        # Advance state to triggering communication outreach (Chasing state)
        invoice.status = "OVERDUE"
        invoice.contact_count = 0
        self.db.commit()
        
        # Run step recovery
        res = simulator.run_step_recovery(self.db, "invoice", invoice.id)
        
        # Verify it handled opt-out, set campaign status to STOPPED_OPT_OUT
        updated_invoice = self.db.query(Invoice).filter(Invoice.id == invoice.id).first()
        self.assertEqual(updated_invoice.recovery_campaign_status, "STOPPED_OPT_OUT")
        
        # Verify corresponding audit log
        latest_audit = self.db.query(AuditLog).filter(
            AuditLog.entity_type == "invoice",
            AuditLog.entity_id == invoice.id
        ).order_by(AuditLog.timestamp.desc()).first()
        self.assertEqual(latest_audit.stage, "STOPPED")
        self.assertEqual(latest_audit.action_taken, "Campaign Cancelled (Opt-Out)")
        
        # Restore override to normal
        gateway.SIMULATION_OVERRIDE = "normal"

    def test_06_secure_api_validations(self):
        """Test API Pydantic validations and HTTP security headers."""
        from fastapi.testclient import TestClient
        from app.main import app
        
        # TestClient uses standard HTTP requests
        # We need to bypass CORS restrictions for the local TestClient context
        client = TestClient(app)
        
        # 1. Test Security Headers
        response = client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["X-XSS-Protection"], "1; mode=block")
        self.assertIn("default-src 'self'", response.headers["Content-Security-Policy"])
        
        # 2. Test Input Validation Failures (Missing Field)
        # Expected: 422 Unprocessable Entity
        bad_response = client.post("/api/gateway-health/toggle", json={"invalid_key": "HDFC"})
        self.assertEqual(bad_response.status_code, 422)
        
        # 3. Test Input Validation Success
        good_response = client.post("/api/gateway-health/toggle", json={"bank": "HDFC"})
        self.assertEqual(good_response.status_code, 200)

    def test_07_ledger_integrity_checks(self):
        """Test cryptographic hash chain signature creation and tamper detection."""
        from fastapi.testclient import TestClient
        from app.main import app
        
        client = TestClient(app)
        
        # Reset and seed database (triggers several audit logs with signatures)
        simulator.seed_synthetic_data(self.db)
        
        # 1. Verify ledger integrity (should succeed out-of-the-box)
        response = client.get("/api/security/verify-ledger")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "secured")
        self.assertEqual(response.json()["tampered"], False)
        
        # 2. Tamper with one audit log record in SQLite directly
        first_log = self.db.query(AuditLog).first()
        self.assertIsNotNone(first_log)
        
        original_action = first_log.action_taken
        first_log.action_taken = "Malicious Altered Action Name"
        self.db.commit()
        
        # 3. Verify ledger integrity again (should raise 500 Compromised error)
        fail_response = client.get("/api/security/verify-ledger")
        self.assertEqual(fail_response.status_code, 500)
        self.assertIn("Ledger Integrity Compromised", fail_response.json()["detail"])
        
        # Restore database state
        first_log.action_taken = original_action
        self.db.commit()

    def test_08_ai_command_center(self):
        """Test AI Copilot Natural Language query filtering and recovery recommendation route."""
        from fastapi.testclient import TestClient
        from app.main import app
        
        client = TestClient(app)
        
        # 1. Test AI search query endpoint
        response = client.get("/api/pipelines?q=failures+on+HDFC+bank")
        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.json(), list)
        
        # 2. Test AI recommendation for a valid payment
        payment = self.db.query(Payment).first()
        if payment:
            rec_response = client.get(f"/api/ai/recommendation/{payment.id}")
            self.assertEqual(rec_response.status_code, 200)
            data = rec_response.json()
            self.assertIn("probability", data)
            self.assertIn("reasoning", data)
            self.assertIn("recommended_action", data)
            self.assertIn("action_label", data)

    def test_09_enterprise_integrity(self):
        """Test database CheckConstraints, automated backup endpoint, and GDPR PII masking."""
        from fastapi.testclient import TestClient
        from app.main import app
        from app.models import Invoice
        from datetime import datetime, timedelta
        
        client = TestClient(app)
        
        # 1. Test database backup endpoint
        backup_res = client.post("/api/security/backup")
        self.assertEqual(backup_res.status_code, 200)
        self.assertEqual(backup_res.json()["status"], "success")
        self.assertTrue(os.path.exists("./razorrecovery_backup.db"))
        
        # 2. Test PII masking in pipelines response
        pipelines_res = client.get("/api/pipelines")
        self.assertEqual(pipelines_res.status_code, 200)
        for item in pipelines_res.json():
            if item["type"] == "invoice":
                # Masked emails should contain asterisks
                self.assertIn("*", item["email"])
                self.assertIn("*", item["name"])
                
        # 3. Test CheckConstraint (amount >= 0)
        bad_invoice = Invoice(
            id="inv_bad_amount",
            customer_name="Bad Guy",
            customer_email="bad@guy.com",
            customer_phone="123456",
            amount=-100.0,  # Violates CheckConstraint!
            due_at=datetime.now(timezone.utc) + timedelta(days=1)
        )
        self.db.add(bad_invoice)
        with self.assertRaises(Exception):
            self.db.commit()
        self.db.rollback()

        # 4. Test secret panel management endpoint
        manage_res = client.get("/manage")
        self.assertEqual(manage_res.status_code, 200)

if __name__ == "__main__":
    unittest.main()
