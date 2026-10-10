// Test only: capture outgoing mail in a file instead of sending it.
const email = require("../src/email");
email.isEnabled = () => true;
email.sendEmail = async (m) => require("fs").appendFileSync(process.env.TEST_OUTBOX || "/var/tmp/outbox.jsonl", JSON.stringify(m) + "\n");
