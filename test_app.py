import os
import unittest
from sqlalchemy.orm import Session
from app.database import engine, SessionLocal, init_db, Base
from app.models import Invoice, Payment, AuditLog, Communication
import app.simulator as simulator

class TestRazorRecovery(unittest.TestCase):
    
    @classmethod
    def setUpClass(cls):
        # Initialize database tables
        init_db()
        cls.db = SessionLocal()
        
    @classmethod
    def tearDownClass(cls):
        cls.db.close()
        engine.dispose()
        # Clean up database file after test
        if os.path.exists("./razorrecovery.db"):
            try:
                pass # Keep it for local running or clean it up if desired
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

if __name__ == "__main__":
    unittest.main()
