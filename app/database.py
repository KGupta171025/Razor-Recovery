import os
from sqlalchemy import create_engine
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
    """Create all tables in the database."""
    Base.metadata.create_all(bind=engine)
