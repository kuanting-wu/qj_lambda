const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const sesClient = new SESClient({ region: process.env.AWS_REGION });

const sendEmail = async (to, subject, htmlBody) => {
  const params = {
    Source: process.env.SES_EMAIL_FROM,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject },
      Body: { Html: { Data: htmlBody } },
    },
  };

  try {
    await sesClient.send(new SendEmailCommand(params));
    return { success: true };
  } catch (error) {
    console.error('Email sending failed:', error);
    return { success: false, error };
  }
};

module.exports = { sendEmail };
