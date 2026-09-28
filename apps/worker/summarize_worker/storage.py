import boto3
from botocore.config import Config

from .config import Settings


class Storage:
    def __init__(self, settings: Settings):
        self.bucket = settings.s3_bucket
        self.s3 = boto3.client("s3", endpoint_url=settings.s3_endpoint, region_name=settings.s3_region,
                               aws_access_key_id=settings.s3_key, aws_secret_access_key=settings.s3_secret,
                               config=Config(s3={"addressing_style": "path"}))

    def get(self, key: str) -> bytes:
        return self.s3.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def put(self, key: str, body: bytes, content_type: str) -> None:
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType=content_type)

    def size(self, key: str) -> int:
        return self.s3.head_object(Bucket=self.bucket, Key=key)["ContentLength"]
