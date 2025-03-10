const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

// Let AWS SDK use the default region configuration provided by Lambda
console.log('Creating SES client...');
let sesClient;
try {
  sesClient = new SESClient();
  console.log('SES client created successfully');
} catch (err) {
  console.error('Error creating SES client:', err);
  // Create dummy client to avoid crashes
  sesClient = {
    send: async () => {
      throw new Error('SES client failed to initialize');
    }
  };
}

const sendEmail = async (to, subject, htmlBody) => {
  console.log(`Attempting to send email to ${to} with subject "${subject}"`);
  
  // Check if SES is configured
  try {
    // Log all environment variables (excluding sensitive ones)
    console.log('Environment variables available:', 
      Object.keys(process.env)
        .filter(key => !key.includes('KEY') && !key.includes('SECRET') && !key.includes('PASSWORD'))
        .join(', ')
    );
    
    // Check FROM email
    if (!process.env.SES_EMAIL_FROM) {
      console.warn('SES_EMAIL_FROM environment variable is not set, email sending will fail');
      return { 
        success: false, 
        error: new Error('SES_EMAIL_FROM environment variable is not set') 
      };
    }
    
    console.log(`Using sender email: ${process.env.SES_EMAIL_FROM}`);
    console.log('AWS_REGION setting:', process.env.AWS_REGION || 'using default');
    
    const params = {
      Source: process.env.SES_EMAIL_FROM,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: { Html: { Data: htmlBody } },
      },
    };
    
    console.log('Sending email with SES...');
    
    try {
      // Add a timeout to prevent hanging on SES calls
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Email sending timed out after 3 seconds')), 3000);
      });
      
      const sendPromise = sesClient.send(new SendEmailCommand(params));
      await Promise.race([sendPromise, timeoutPromise]);
      
      console.log('Email sent successfully');
      return { success: true };
    } catch (error) {
      if (error.message.includes('timed out')) {
        console.error('Email sending timed out - SES may not be properly configured');
      } else {
        console.error('Email sending failed:', error.message);
        console.error('Error details:', JSON.stringify({
          code: error.code,
          name: error.name, 
          message: error.message,
          requestId: error.$metadata?.requestId,
          stack: error.stack
        }, null, 2));
      }
      return { success: false, error };
    }
  } catch (setupError) {
    console.error('Email setup error:', setupError);
    return { success: false, error: setupError };
  }
};

module.exports = { sendEmail };
