const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

// Let AWS SDK use the default region configuration provided by Lambda
console.log('Creating SES client...');
let sesClient;
try {
  // Create client with specific configuration to help diagnose issues
  sesClient = new SESClient({
    retryMode: 'standard',
    maxAttempts: 1, // Reduce retry attempts for faster failure
    requestHandler: {
      connectionTimeout: 1000 // 1 second connection timeout
    }
  });
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
      // Try to send the email with a 1 second timeout
      // This is a very short timeout, but in Lambda we want to fail fast
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Email sending timed out after 1 second')), 1000);
      });
      
      console.log('Sending email command to SES...');
      const sendPromise = sesClient.send(new SendEmailCommand(params));
      
      try {
        await Promise.race([sendPromise, timeoutPromise]);
      } catch (raceError) {
        if (raceError.message.includes('timed out')) {
          console.warn('SES timed out - starting network diagnostic...');
          
          // Test basic internet connectivity
          try {
            console.log('Testing network connectivity...');
            const https = require('https');
            
            const connTestPromise = new Promise((resolve, reject) => {
              const req = https.get('https://www.google.com', (res) => {
                console.log(`Network test successful, status: ${res.statusCode}`);
                res.resume();
                resolve(true);
              });
              
              req.on('error', (e) => {
                console.error(`Network test error: ${e.message}`);
                resolve(false);
              });
              
              req.setTimeout(1000, () => {
                console.error('Network test timed out');
                req.destroy();
                resolve(false);
              });
            });
            
            const connResult = await Promise.race([
              connTestPromise,
              new Promise((_, reject) => setTimeout(() => reject(new Error('Network test outer timeout')), 1500))
            ]);
            
            if (connResult) {
              console.log('Lambda has internet connectivity, likely a permission issue with SES');
              throw new Error('Email sending timed out. Lambda has internet connectivity but SES API call failed. Check IAM permissions.');
            } else {
              console.error('Lambda appears to have NO internet connectivity. Check VPC configuration.');
              throw new Error('Email sending timed out. Lambda has no internet connectivity. Check VPC configuration and ensure Lambda has a route to internet.');
            }
          } catch (netTestError) {
            console.error(`Network test failed: ${netTestError.message}`);
            console.log(`Is "${params.Source}" verified in SES? Account might still be in sandbox mode.`);
            throw new Error('Email sending timed out. Network diagnostic also failed. Check Lambda networking and IAM permissions.');
          }
        }
        throw raceError;
      }
      
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
