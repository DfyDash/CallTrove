// Transactional email via Amazon SES -- account-security mail only (email
// verification, OTP login codes, and similar), never marketing. See
// .env.example's comment: uses the standard AWS SDK credential chain (an
// IAM role on the instance in production), no access key stored here.

const REGION = process.env.SES_REGION;
const FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS;

function isEnabled() {
  return !!REGION && !!FROM_ADDRESS;
}

let sesClient;
function getClient() {
  if (!sesClient) {
    const { SESClient } = require("@aws-sdk/client-ses");
    sesClient = new SESClient({ region: REGION });
  }
  return sesClient;
}

async function sendEmail({ to, subject, text }) {
  if (!isEnabled()) {
    throw new Error("Email sending is not configured (SES_REGION / EMAIL_FROM_ADDRESS)");
  }
  const { SendEmailCommand } = require("@aws-sdk/client-ses");
  await getClient().send(
    new SendEmailCommand({
      Source: FROM_ADDRESS,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: { Text: { Data: text, Charset: "UTF-8" } },
      },
    })
  );
}

module.exports = { isEnabled, sendEmail };
