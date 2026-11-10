/** Verifies dist/snapshot.json against its detached signature and the committed public key. */
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const bytes = readFileSync(join(root, "dist/snapshot.json"));
const signature = Buffer.from(readFileSync(join(root, "dist/snapshot.json.sig"), "utf8").trim(), "base64");
const key = createPublicKey(readFileSync(join(root, "registry-public.pem")));

if (!verify(null, bytes, key, signature)) {
  process.stderr.write("The snapshot signature does not match registry-public.pem. Do not publish it.\n");
  process.exit(1);
}
process.stdout.write(`Signature verified for ${bytes.byteLength} bytes.\n`);
