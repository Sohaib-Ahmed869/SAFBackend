// emailUtil.js
const nodemailer = require("nodemailer");
const path = require("path");


// Create Outlook transporter
const createOutlookTransporter = () => {
  console.log("Creating Outlook transporter...");
  return nodemailer.createTransport({
    host: "smtp-mail.outlook.com",
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    tls: {
      ciphers: "SSLv3",
    },
  });
};

// Create Gmail transporter
const createGmailTransporter = () => {
  console.log("Creating Gmail transporter...");
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS, // Use App Password for Gmail
    },
  });
};

// Test transporter connection
const testTransporter = async (transporter, provider) => {
  try {
    console.log(`Testing ${provider} connection...`);
    await new Promise((resolve, reject) => {
      transporter.verify((error, success) => {
        if (error) {
          console.error(` ${provider} SMTP Connection Error:`, error);
          reject(error);
        } else {
          console.log(`${provider} SMTP Server is ready`);
          resolve(success);
        }
      });
    });
    return true;
  } catch (error) {
    console.error(` ${provider} connection failed:`, error.message);
    return false;
  }
};

// Initialize email system with fallback
let activeTransporter = null;
let activeProvider = null;

const initializeEmailSystem = async () => {
 
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.error("Email credentials not configured");
    return;
  }

  // Try Outlook first
  const outlookTransporter = createOutlookTransporter();
  const outlookWorks = await testTransporter(outlookTransporter, "Outlook");
  
  if (outlookWorks) {
    activeTransporter = outlookTransporter;
    activeProvider = "Outlook";
    console.log("Using Outlook as primary email provider");
  } else {
    // Fallback to Gmail
    console.log("Outlook failed, trying Gmail...");
    const gmailTransporter = createGmailTransporter();
    const gmailWorks = await testTransporter(gmailTransporter, "Gmail");
    
    if (gmailWorks) {
      activeTransporter = gmailTransporter;
      activeProvider = "Gmail";
      console.log("Using Gmail as fallback email provider");
    } else {
      console.error("Both Outlook and Gmail failed");
      activeTransporter = null;
      activeProvider = null;
    }
  }
};

// Initialize on module load
initializeEmailSystem();

// Utility function to send an email
const sendEmail = async (
  recipientEmail,
  emailBody,
  emailSubject,
  attachments = []
) => {
  try {
  
    if (!activeTransporter) {
      console.error("No email transporter available");
      return { success: false, message: "Email system not configured", error: "No transporter available" };
    }

    const mailOptions = {
      from: `"Shahid Afridi Foundation" <${process.env.EMAIL_USER}>`,
      to: recipientEmail,
      subject: emailSubject,
      text: emailBody.replace(/<[^>]*>/g, ""), // Plain text body (strip HTML)
      html: ` 
        <div>
          ${emailBody}
        </div>
       `,
      attachments: attachments,
    };

    console.log("Mail options prepared, attempting to send...");

    // Send the email
    const info = await activeTransporter.sendMail(mailOptions);
    console.log(`Email sent successfully via ${activeProvider}:`, info.response);
    console.log("Message ID:", info.messageId);
    return { 
      success: true, 
      message: `Email sent successfully via ${activeProvider}`, 
      messageId: info.messageId,
      provider: activeProvider
    };
  } catch (error) {
    console.error(`Error sending email via ${activeProvider}:`, error);
    console.error("Error details:", { 
      code: error.code, 
      command: error.command, 
      responseCode: error.responseCode, 
      response: error.response 
    });
    
    // If current provider fails, try to switch to the other one
    if (activeProvider === "Outlook") {
      console.log("Outlook failed, trying Gmail as fallback...");
      const gmailTransporter = createGmailTransporter();
      const gmailWorks = await testTransporter(gmailTransporter, "Gmail");
      
      if (gmailWorks) {
        activeTransporter = gmailTransporter;
        activeProvider = "Gmail";
        console.log(" Switched to Gmail, retrying...");
        
        // Retry with Gmail
        try {
          const info = await activeTransporter.sendMail(mailOptions);
          console.log("Email sent successfully via Gmail fallback:", info.response);
          return { 
            success: true, 
            message: "Email sent successfully via Gmail fallback", 
            messageId: info.messageId,
            provider: "Gmail (fallback)"
          };
        } catch (fallbackError) {
          console.error("Gmail fallback also failed:", fallbackError);
        }
      }
    } else if (activeProvider === "Gmail") {
      console.log("Gmail failed, trying Outlook as fallback...");
      const outlookTransporter = createOutlookTransporter();
      const outlookWorks = await testTransporter(outlookTransporter, "Outlook");
      
      if (outlookWorks) {
        activeTransporter = outlookTransporter;
        activeProvider = "Outlook";
        console.log("Switched to Outlook, retrying...");
        
        // Retry with Outlook
        try {
          const info = await activeTransporter.sendMail(mailOptions);
          console.log("Email sent successfully via Outlook fallback:", info.response);
          return { 
            success: true, 
            message: "Email sent successfully via Outlook fallback", 
            messageId: info.messageId,
            provider: "Outlook (fallback)"
          };
        } catch (fallbackError) {
          console.error("Outlook fallback also failed:", fallbackError);
        }
      }
    }
    
    return { success: false, message: "Failed to send email", error: error.message };
  }
};

// Test function to verify email configuration
const testEmailConfig = async () => {
  try {
    console.log("=== TESTING EMAIL CONFIGURATION ===");
    
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.error("Missing email environment variables");
      return { success: false, message: "Missing email environment variables" };
    }

    const testResult = await sendEmail(
      "info@shahidafridifoundation.org.au",
      "<h1>Test Email</h1><p>This is a test email to verify configuration.</p>",
      "Email Configuration Test"
    );

    console.log("Test result:", testResult);
    return {
      ...testResult,
      activeProvider,
      systemStatus: activeTransporter ? "Configured" : "Not Configured"
    };
  } catch (error) {
    console.error("Test failed:", error);
    return { 
      success: false, 
      message: "Test failed", 
      error: error.message,
      activeProvider,
      systemStatus: activeTransporter ? "Configured" : "Not Configured"
    };
  }
};

const getEmailStatus = () => {
  return {
    configured: !!activeTransporter,
    provider: activeProvider,
    emailUser: process.env.EMAIL_USER ? "SET" : "NOT SET",
    emailPass: process.env.EMAIL_PASS ? "SET" : "NOT SET"
  };
};

module.exports = { sendEmail, testEmailConfig, getEmailStatus };
