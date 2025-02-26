// utils/receiptUtil.js
const PDFDocument = require("pdfkit");
const fs = require("fs-extra");
const path = require("path");
const { sendEmail } = require("./emailUtil");
const os = require("os");

/**
 * Generates a PDF receipt for an order
 * @param {Object} order - The order object
 * @returns {Promise<{filePath: string, fileName: string}>} - Path to the generated PDF
 */
const generateReceiptPDF = async (order) => {
  // Create a temporary file path
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-"));
  const fileName = `receipt-${order.donationId}.pdf`;
  const filePath = path.join(tempDir, fileName);

  return new Promise((resolve, reject) => {
    try {
      // Create a new PDF document
      const doc = new PDFDocument({ margin: 50 });
      const writeStream = fs.createWriteStream(filePath);

      // Pipe the PDF to the file
      doc.pipe(writeStream);

      // Add logos
      doc
        .image(path.join(__dirname, "../public/images/logo.png"), 50, 45, {
          width: 80,
        })
        .image(
          path.join(__dirname, "../public/images/tax-deductible.png"),
          450,
          45,
          { width: 100 }
        );

      // Add header
      doc.fontSize(18).text("Shahid Afridi Foundation Ltd", 50, 130);
      doc.fontSize(14).text("Donation Receipt", 50, 155);
      doc
        .fontSize(10)
        .text(`Financial Year ${getCurrentFinancialYear()}`, 50, 175);

      // Add ABN and other details
      doc
        .fontSize(10)
        .text("ABN: 97 642 657 010", 400, 140)
        .text(`Date of Issue: ${formatDate(new Date())}`, 400, 155)
        .text(`Reference: ${order.donationId}`, 400, 170);

      // Add donor details
      doc.moveDown(2);
      doc.fontSize(10).text(`Name: ${order.donorDetails.name}`, 50, 210);
      if (order.donorDetails.address) {
        const address = formatAddress(order.donorDetails.address);
        doc.text(`Address: ${address}`);
      }
      doc.text(`Email: ${order.donorDetails.email}`);
      if (order.donorDetails.phone) {
        doc.text(`Phone: ${order.donorDetails.phone}`);
      }

      // Add donation table
      doc.moveDown(2);
      createTable(
        doc,
        [
          {
            donation_date: "Donation Date",
            description: "Description",
            amount: "Donation Amount (AUD)",
          },
        ],
        50,
        doc.y
      );

      // Add donation details for each item
      const donationDate = formatDate(order.createdAt);
      order.items.forEach((item) => {
        createTable(
          doc,
          [
            {
              donation_date: donationDate,
              description: `${item.title}${
                item.onBehalfOf ? ` (on behalf of ${item.onBehalfOf})` : ""
              }`,
              amount: `$${(item.price * (item.quantity || 1)).toFixed(2)}`,
            },
          ],
          50,
          doc.y
        );
      });

      // Add admin contribution if included
      if (order.adminCostContribution && order.adminCostContribution.included) {
        createTable(
          doc,
          [
            {
              donation_date: donationDate,
              description: "Admin Cost Contribution",
              amount: `$${order.adminCostContribution.amount.toFixed(2)}`,
            },
          ],
          50,
          doc.y
        );
      }

      // Add total amount
      doc.moveDown(1);
      doc.fontSize(12).text(`Total Amount: $${order.totalAmount.toFixed(2)}`, {
        align: "right",
      });

      // Add payment details
      doc.moveDown(2);
      doc
        .fontSize(11)
        .text(`Payment Method: ${formatPaymentMethod(order.paymentMethod)}`);
      doc
        .fontSize(11)
        .text(`Payment Type: ${formatPaymentType(order.paymentType)}`);
      doc
        .fontSize(11)
        .text(`Payment Status: ${formatPaymentStatus(order.paymentStatus)}`);

      // Add footer
      doc.moveDown(3);
      const footerText =
        "www.donateSAF.com.au | syed.atif@shahidafridifoundation.org | +61 413 911 091";
      doc.fontSize(9).text(footerText, 50, 700, { align: "center" });

      // Finalize the PDF and end the stream
      doc.end();

      writeStream.on("finish", () => {
        resolve({ filePath, fileName });
      });

      writeStream.on("error", (err) => {
        reject(err);
      });
    } catch (error) {
      reject(error);
    }
  });
};

/**
 * Creates a table row in the PDF
 * @param {PDFDocument} doc - The PDF document
 * @param {Array} data - Array of objects containing row data
 * @param {number} x - X position
 * @param {number} y - Y position
 */
const createTable = (doc, data, x, y) => {
  // Set column widths
  const dateColWidth = 100;
  const descColWidth = 280;
  const amountColWidth = 100;

  // Set row height
  const rowHeight = 20;

  data.forEach((row) => {
    doc
      .fontSize(9)
      .text(row.donation_date, x, y, { width: dateColWidth })
      .text(row.description, x + dateColWidth, y, { width: descColWidth })
      .text(row.amount, x + dateColWidth + descColWidth, y, {
        width: amountColWidth,
        align: "right",
      });

    // Draw horizontal line after each row
    doc
      .moveTo(x, y + rowHeight)
      .lineTo(x + dateColWidth + descColWidth + amountColWidth, y + rowHeight)
      .stroke();

    y += rowHeight;
  });

  return y;
};

/**
 * Formats an address object into a string
 * @param {Object} address - The address object
 * @returns {string} - Formatted address
 */
const formatAddress = (address) => {
  const parts = [];
  if (address.street) parts.push(address.street);
  if (address.city) parts.push(address.city);
  if (address.state) parts.push(address.state);
  if (address.postcode) parts.push(address.postcode);

  return parts.join(", ");
};

/**
 * Formats a date into DD-MM-YYYY format
 * @param {Date} date - The date to format
 * @returns {string} - Formatted date
 */
const formatDate = (date) => {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();

  return `${year}-${month}-${day}`;
};

/**
 * Gets the current financial year string (e.g., "2024/2025")
 * @returns {string} - Current financial year
 */
const getCurrentFinancialYear = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 0-indexed

  // In Australia, financial year runs from July 1 to June 30
  if (month >= 7) {
    return `${year}/${year + 1}`;
  } else {
    return `${year - 1}/${year}`;
  }
};

/**
 * Formats payment method for display
 * @param {string} method - Payment method code
 * @returns {string} - Formatted payment method
 */
const formatPaymentMethod = (method) => {
  const methods = {
    card: "Credit/Debit Card",
    bank: "Bank Transfer",
    paypal: "PayPal",
  };

  return methods[method] || method;
};

/**
 * Formats payment type for display
 * @param {string} type - Payment type code
 * @returns {string} - Formatted payment type
 */
const formatPaymentType = (type) => {
  const types = {
    single: "One-Time Donation",
    recurring: "Recurring Donation",
    installments: "Installment Plan",
  };

  return types[type] || type;
};

/**
 * Formats payment status for display
 * @param {string} status - Payment status code
 * @returns {string} - Formatted payment status
 */
const formatPaymentStatus = (status) => {
  const statuses = {
    completed: "Paid",
    processing: "Processing",
    pending: "Pending",
    failed: "Failed",
  };

  return statuses[status] || status;
};

/**
 * Sends a receipt email to the donor
 * @param {Object} order - The order object
 * @returns {Promise<Object>} - Result of the email sending operation
 */
const sendReceiptEmail = async (order) => {
  try {
    // Generate the PDF receipt
    const { filePath, fileName } = await generateReceiptPDF(order);

    // Create email subject and body
    const emailSubject = `Shahid Afridi Foundation - Donation Receipt ${order.donationId}`;
    const emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="text-align: center; padding: 20px 0;">
          <img src="https://safimages.s3.ap-southeast-2.amazonaws.com/events/Screenshot+2025-02-27+014744.png" alt="Shahid Afridi Foundation" style="max-width: 150px;">
        </div>
        
        <h2 style="color: #4a7c59;">Thank You for Your Donation!</h2>
        
        <p>Dear ${order.donorDetails.name},</p>
        
        <p>Thank you for your generous donation to the Shahid Afridi Foundation. Your support helps us make a difference in the lives of those in need.</p>
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0;">Donation Details:</h3>
          <p><strong>Donation ID:</strong> ${order.donationId}</p>
          <p><strong>Date:</strong> ${formatDate(order.createdAt)}</p>
          <p><strong>Amount:</strong> $${order.totalAmount.toFixed(2)} AUD</p>
          <p><strong>Payment Method:</strong> ${formatPaymentMethod(
            order.paymentMethod
          )}</p>
        </div>
        
        <p>Your official tax-deductible receipt is attached to this email. Please keep it for your tax records.</p>
        
        ${
          order.paymentMethod === "bank"
            ? getBankTransferInstructions(order)
            : ""
        }
        
        <p>If you have any questions or need further assistance, please don't hesitate to contact us at <a href="mailto:syed.atif@shahidafridifoundation.org">syed.atif@shahidafridifoundation.org</a> or call us at +61 413 911 091.</p>
        
        <p>Warm regards,<br>
        Shahid Afridi Foundation Team</p>
        
        <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #777;">
          <p>Shahid Afridi Foundation Ltd | ABN: 97 642 657 010<br>
          <a href="https://www.donateSAF.com.au">www.donateSAF.com.au</a> | <a href="mailto:syed.atif@shahidafridifoundation.org">syed.atif@shahidafridifoundation.org</a> | +61 413 911 091</p>
        </div>
      </div>
    `;

    // Setup email options with attachment
    const mailOptions = {
      from: `"Shahid Afridi Foundation" <${process.env.EMAIL_USER}>`,
      to: order.donorDetails.email,
      subject: emailSubject,
      html: emailBody,
      attachments: [
        {
          filename: fileName,
          path: filePath,
          contentType: "application/pdf",
        },
      ],
    };

    // Send the email
    const info = await sendEmail(
      order.donorDetails.email,
      emailBody,
      emailSubject,
      mailOptions.attachments
    );
    console.log("Receipt email sent: ", info.response);

    // Cleanup - remove temporary file
    await fs.remove(filePath);

    return { success: true, message: "Receipt email sent successfully" };
  } catch (error) {
    console.error("Error sending receipt email: ", error);
    return { success: false, message: "Failed to send receipt email", error };
  }
};

/**
 * Gets bank transfer instructions for email body
 * @param {Object} order - The order object
 * @returns {string} - HTML string with bank transfer instructions
 */
const getBankTransferInstructions = (order) => {
  return `
    <div style="background-color: #fffaed; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #ffc107;">
      <h3 style="margin-top: 0; color: #856404;">Bank Transfer Instructions:</h3>
      <p>Please use the following details to complete your bank transfer:</p>
      <ul style="padding-left: 20px;">
        <li><strong>Bank Name:</strong> Westpac</li>
        <li><strong>BSB:</strong> 032075</li>
        <li><strong>Account Number:</strong> 841783</li>
        <li><strong>Reference:</strong> ${order.donationId} (Important: Please include this reference)</li>
      </ul>
      <p><strong>Note:</strong> Your donation will be marked as completed once we receive your payment.</p>
    </div>
  `;
};

module.exports = { generateReceiptPDF, sendReceiptEmail };
