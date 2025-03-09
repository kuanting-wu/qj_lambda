const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

// Let AWS SDK use the default region configuration provided by Lambda
const sesClient = new SESClient();

const sendEmail = async (to, subject, htmlBody) => {
  // Check if SES_EMAIL_FROM is configured
  if (!process.env.SES_EMAIL_FROM) {
    console.warn('SES_EMAIL_FROM environment variable is not set, email sending will fail');
    return { success: false, error: new Error('SES_EMAIL_FROM environment variable is not set') };
  }

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
