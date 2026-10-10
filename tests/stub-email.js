// Test only: capture outgoing mail in a file instead of sending it.
const email = require("../src/email");
email.isEnabled = () => true;
// Create this file to make the next sends fail (simulates the email provider being down).
email.sendEmail = async (m) => {
  if (require("fs").existsSync("/var/tmp/ct-test-fail-email")) throw new Error("simulated email outage");
  return require("fs").appendFileSync(process.env.TEST_OUTBOX || "/var/tmp/outbox.jsonl", JSON.stringify(m) + "\n");
};
