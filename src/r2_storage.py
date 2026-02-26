"""
Cloudflare R2 Storage Integration
Stores audit reports in R2 bucket with automatic URL generation
"""
import logging
import json
from datetime import datetime
import boto3
from botocore.exceptions import ClientError
from src.config import Config

logger = logging.getLogger(__name__)


class R2Storage:
    """Cloudflare R2 storage client (S3-compatible)"""
    
    def __init__(self):
        """Initialize R2 client with credentials"""
        self.enabled = self._check_credentials()
        self.bucket_name = Config.R2_BUCKET_NAME
        self.s3_client = None
        
        if self.enabled:
            self._init_client()
    
    def _check_credentials(self) -> bool:
        """Check if R2 credentials are configured"""
        required = [
            Config.R2_ACCOUNT_ID,
            Config.R2_ACCESS_KEY_ID,
            Config.R2_SECRET_ACCESS_KEY,
            Config.R2_BUCKET_NAME
        ]
        
        if all(required):
            logger.info("✅ R2 credentials configured and available")
            return True
        else:
            logger.warning("⚠️ R2 storage disabled - missing credentials")
            return False
    
    def _init_client(self):
        """Initialize boto3 S3 client for Cloudflare R2"""
        try:
            # R2 S3-compatible endpoint
            r2_endpoint_url = (
                f"https://{Config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
            )
            
            self.s3_client = boto3.client(
                "s3",
                endpoint_url=r2_endpoint_url,
                aws_access_key_id=Config.R2_ACCESS_KEY_ID,
                aws_secret_access_key=Config.R2_SECRET_ACCESS_KEY,
                region_name="auto"  # R2 uses 'auto' region
            )
            
            logger.debug(f"✅ R2 client initialized: {r2_endpoint_url}")
        
        except Exception as e:
            logger.error(f"❌ Failed to initialize R2 client: {e}")
            self.enabled = False
            self.s3_client = None
    
    def upload_audit_report(
        self,
        contract_address: str,
        audit_result: dict,
        report_text: str = None
    ) -> dict:
        """
        Upload audit report to R2 bucket
        
        Args:
            contract_address: Solana contract address
            audit_result: Full audit result dict from SecurityAuditor
            report_text: Formatted report text for Telegram display
        
        Returns:
            dict with keys:
            - status: "success", "skipped", or "error"
            - report_url: Public R2 URL to report
            - object_key: Storage path in R2
            - size_bytes: File size uploaded
        """
        
        if not self.enabled or not self.s3_client:
            return {
                "status": "skipped",
                "reason": "R2 storage not configured"
            }
        
        try:
            # Generate object key (path in R2 bucket)
            timestamp = datetime.utcnow().isoformat()
            object_key = f"audits/{contract_address[:8]}/{timestamp}.json"
            
            # Prepare report data
            report_data = {
                "contract_address": contract_address,
                "timestamp": timestamp,
                "audit_result": audit_result,
                "report_summary": report_text if report_text else audit_result.get("findings", ""),
                "environment": Config.ENVIRONMENT
            }
            
            # Convert to JSON
            report_json = json.dumps(report_data, indent=2)
            
            # Upload to R2
            logger.info(f"Uploading audit report to R2: {object_key}")
            self.s3_client.put_object(
                Bucket=self.bucket_name,
                Key=object_key,
                Body=report_json.encode("utf-8"),
                ContentType="application/json",
                Metadata={
                    "contract-address": contract_address,
                    "audit-timestamp": timestamp
                }
            )
            
            # Generate public URL (R2 public bucket URL)
            public_url = (
                f"https://{Config.R2_ACCOUNT_ID}.r2.dev/audits/"
                f"{contract_address[:8]}/{timestamp}.json"
            )
            
            size_bytes = len(report_json.encode("utf-8"))
            
            logger.info(
                f"✅ Audit uploaded to R2 | "
                f"Key: {object_key} | "
                f"Size: {size_bytes} bytes | "
                f"URL: {public_url}"
            )
            
            return {
                "status": "success",
                "report_url": public_url,
                "object_key": object_key,
                "size_bytes": size_bytes
            }
        
        except ClientError as e:
            logger.error(f"❌ R2 upload failed (ClientError): {e}")
            return {
                "status": "error",
                "error": str(e),
                "error_type": "ClientError"
            }
        
        except Exception as e:
            logger.error(f"❌ R2 upload failed: {e}", exc_info=True)
            return {
                "status": "error",
                "error": str(e),
                "error_type": type(e).__name__
            }
    
    def get_audit_report(self, object_key: str) -> dict:
        """
        Retrieve audit report from R2
        
        Args:
            object_key: Path in R2 bucket (e.g., "audits/EvXNCtao/...")
        
        Returns:
            dict with report data or error
        """
        
        if not self.enabled or not self.s3_client:
            return {"status": "skipped", "reason": "R2 storage not configured"}
        
        try:
            logger.info(f"Retrieving audit from R2: {object_key}")
            
            response = self.s3_client.get_object(
                Bucket=self.bucket_name,
                Key=object_key
            )
            
            report_json = response["Body"].read().decode("utf-8")
            report_data = json.loads(report_json)
            
            logger.info(f"✅ Retrieved audit from R2: {object_key}")
            
            return {
                "status": "success",
                "data": report_data
            }
        
        except ClientError as e:
            if e.response["Error"]["Code"] == "NoSuchKey":
                logger.warning(f"⚠️ Audit not found in R2: {object_key}")
                return {"status": "not_found"}
            else:
                logger.error(f"❌ R2 retrieval failed: {e}")
                return {"status": "error", "error": str(e)}
        
        except Exception as e:
            logger.error(f"❌ R2 retrieval failed: {e}")
            return {"status": "error", "error": str(e)}
    
    def list_audits(self, contract_address: str = None, limit: int = 10) -> dict:
        """
        List audit reports from R2
        
        Args:
            contract_address: Filter by contract (optional, first 8 chars)
            limit: Max results
        
        Returns:
            dict with audit list
        """
        
        if not self.enabled or not self.s3_client:
            return {"status": "skipped"}
        
        try:
            # Determine prefix for filtering
            prefix = "audits/"
            if contract_address:
                prefix += contract_address[:8] + "/"
            
            logger.info(f"Listing audits from R2 with prefix: {prefix}")
            
            response = self.s3_client.list_objects_v2(
                Bucket=self.bucket_name,
                Prefix=prefix,
                MaxKeys=limit
            )
            
            audits = []
            if "Contents" in response:
                for obj in response["Contents"]:
                    audits.append({
                        "key": obj["Key"],
                        "size": obj["Size"],
                        "last_modified": obj["LastModified"].isoformat(),
                        "url": f"https://{Config.R2_ACCOUNT_ID}.r2.dev/{obj['Key']}"
                    })
            
            logger.info(f"✅ Found {len(audits)} audits in R2")
            
            return {
                "status": "success",
                "audits": audits,
                "count": len(audits)
            }
        
        except Exception as e:
            logger.error(f"❌ R2 list failed: {e}")
            return {"status": "error", "error": str(e)}


# Global R2 instance
r2_storage = R2Storage()


def upload_audit_to_r2(contract_address: str, audit_result: dict, report_text: str = None) -> dict:
    """Convenience function to upload audit to R2"""
    return r2_storage.upload_audit_report(contract_address, audit_result, report_text)


if __name__ == "__main__":
    # Test R2 storage (requires credentials in .env)
    print("Testing R2 Storage...")
    
    test_audit = {
        "status": "success",
        "contract_address": "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf",
        "findings": "Test findings",
        "tokens_used": 100,
        "cost_usd": 0.0030
    }
    
    result = upload_audit_to_r2(
        "EvXNCtaoVuC1NQLQswAnqsbQKPgVTdjrrLKa8MpMJiLf",
        test_audit,
        "Test report"
    )
    print(result)
