import os
import subprocess

import psycopg
import pytest
from psycopg.rows import dict_row

from summarize_worker.config import Settings
from summarize_worker.storage import Storage

TEST_DB = "postgresql://summarize:summarize@localhost:5432/summarize_test_worker"


@pytest.fixture(scope="session")
def migrated():
    # ponytail: `migrate reset` is destructive and blocked for AI agents; `migrate deploy` is
    # non-destructive and idempotent, isolation between tests comes from the `conn` fixture's TRUNCATE.
    subprocess.run("pnpm --filter @summarize/db exec prisma migrate deploy",
                   shell=True, check=True, env={**os.environ, "DATABASE_URL": TEST_DB})


@pytest.fixture
def settings():
    return Settings(database_url=TEST_DB, s3_endpoint="http://localhost:9000", s3_region="us-east-1",
                    s3_bucket="summarize-test", s3_key="summarize", s3_secret="summarize-secret",
                    llm_base_url="fake", llm_api_key="", llm_model="fake", ocr_langs=None,
                    models=(("default", "fake"), ("alt", "alt-model")))


@pytest.fixture
def conn(migrated, settings):
    c = psycopg.connect(settings.database_url, autocommit=True, row_factory=dict_row)
    c.execute('TRUNCATE "CreditLedger", "Job", "Document", "Session", "AuthAccount", "MagicLinkToken", "User" CASCADE')
    yield c
    c.close()


@pytest.fixture
def storage(settings):
    return Storage(settings)
