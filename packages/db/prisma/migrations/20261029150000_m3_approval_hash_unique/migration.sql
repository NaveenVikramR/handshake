-- One assertion can never approve two approvals (same cart and nonce).
CREATE UNIQUE INDEX "approvals_hash_key" ON "approvals"("hash");
