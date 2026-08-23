import os
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import declarative_base, sessionmaker

DATABASE_URL = "sqlite:///./razorrecovery.db"

# Create database engine
engine = create_engine(
    DATABASE_URL, connect_args={"check_same_thread": False}
)

# Session local factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Base class for DB models
Base = declarative_base()

def get_db():
    """Dependency to get DB session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def init_db():
    """Create all tables in the database with schema self-healing."""
    # Check if database has outdated schemas (e.g. missing hash_signature column)
    try:
        inspector = inspect(engine)
        tables = inspector.get_table_names()
        if "audit_logs" in tables:
            columns = [c["name"] for c in inspector.get_columns("audit_logs")]
            if "hash_signature" not in columns:
                # Old schema detected, drop all tables to trigger fresh creation
                Base.metadata.drop_all(bind=engine)
    except Exception:
        pass
        
    Base.metadata.create_all(bind=engine)
