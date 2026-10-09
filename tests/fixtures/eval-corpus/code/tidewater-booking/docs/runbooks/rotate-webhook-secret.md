# Runbook: rotate the payment webhook signing secret

1. In the payment provider dashboard, choose "roll secret" with a 24 hour overlap. Never choose "expire now".
2. Copy the new secret into the secrets manager as PAYMENT_WEBHOOK_SECRET for staging.
3. Deploy staging and send a test event from the dashboard. Check for "ok" in the logs.
4. Repeat for production.
5. After 24 hours the old secret stops working. Watch the signature failure alert for that hour.
