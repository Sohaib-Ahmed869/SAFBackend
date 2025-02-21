// emailUtil.js
const nodemailer = require("nodemailer");

// Configure the transporter for nodemailer
const transporter = nodemailer.createTransport({
  service: "gmail", // Use your email service provider (e.g., Gmail, Outlook, etc.)
  auth: {
    user: process.env.EMAIL_USER, // Your email address (store in environment variable for security)
    pass: process.env.EMAIL_PASS, // Your email password (store in environment variable)
  },
});

// Utility function to send an email
const sendEmail = async (recipientEmail, emailBody, emailSubject) => {
  try {
    const mailOptions = {
      from: `"Shahid Afridi Foundation" <${process.env.EMAIL_USER}>`,
      to: recipientEmail, // Recipient's email address
      subject: emailSubject, // Subject of the email
      text: emailBody, // Plain text body
      html: ` 
        <div>
          <p>${emailBody}</p>
        </div>
       `,
    };

    // Send the email
    const info = await transporter.sendMail(mailOptions);
    console.log("Email sent: ", info.response);
    return { success: true, message: "Email sent successfully" };
  } catch (error) {
    console.error("Error sending email: ", error);
    return { success: false, message: "Failed to send email", error };
  }
};

module.exports = { sendEmail };
