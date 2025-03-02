// utils/receiptUtil.js
const PDFDocument = require("pdfkit");
const fs = require("fs-extra");
const path = require("path");
const { sendEmail } = require("./emailUtil");
const os = require("os");

/**
 * Generates a PDF receipt for an order
 * @param {Object} order - The order object
 * @param {Number} installmentNumber - Optional specific installment number
 * @param {Boolean} paidOnly - Only include paid items (for installments)
 * @returns {Promise<{filePath: string, fileName: string}>} - Path to the generated PDF
 */
const generateReceiptPDF = async (
  order,
  installmentNumber = null,
  paidOnly = false
) => {
  // Create a temporary file path
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-"));

  // Generate filename - add installment info if applicable
  let fileName = `receipt-${order.donationId}`;
  if (installmentNumber && order.paymentType === "installments") {
    fileName += `-I${installmentNumber}`;
  }
  fileName += ".pdf";

  const filePath = path.join(tempDir, fileName);

  return new Promise((resolve, reject) => {
    try {
      // Create a new PDF document
      const doc = new PDFDocument({ margin: 50 });
      const writeStream = fs.createWriteStream(filePath);

      // Pipe the PDF to the file
      doc.pipe(writeStream);

      // Add logos
      doc.image(path.join(__dirname, "../public/images/logo.png"), 50, 45, {
        width: 80,
      });

      doc.image(
        path.join(__dirname, "../public/images/tax-deductible.png"),
        450,
        45,
        { width: 100 }
      );

      // Add header
      doc.fontSize(18).text("Shahid Afridi Foundation Ltd", 50, 130);

      // Customize title based on payment type and installment
      if (order.paymentType === "installments" && installmentNumber) {
        doc
          .fontSize(14)
          .text(`Installment ${installmentNumber} Receipt`, 50, 155);
      } else if (order.paymentType === "installments" && paidOnly) {
        doc.fontSize(14).text("Installment Payments Receipt", 50, 155);
      } else if (order.paymentType === "recurring") {
        doc.fontSize(14).text("Recurring Donation Receipt", 50, 155);
      } else {
        doc.fontSize(14).text("Donation Receipt", 50, 155);
      }

      // Financial year
      const financialYear = getCurrentFinancialYear(order.createdAt);
      doc.fontSize(10).text(`Financial Year ${financialYear}`, 50, 175);

      // Add ABN and other details
      doc.fontSize(10).text("ABN: 97 642 657 010", 400, 140);
      doc.text(`Date of Issue: ${formatDate(new Date())}`, 400, 155);

      // Reference - add installment number for installment payments
      let reference = order.donationId;
      if (order.paymentType === "installments" && installmentNumber) {
        reference += `-I${installmentNumber}`;
      }
      doc.text(`Reference: ${reference}`, 400, 170);

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

      // Create table data based on payment type and options
      const tableData = getTableData(order, installmentNumber, paidOnly);

      // Add each row to the table
      let totalAmount = 0;

      tableData.forEach((row) => {
        createTable(doc, [row], 50, doc.y);
        totalAmount += parseFloat(row.amount.replace("$", ""));
      });

      // Add total amount
      doc.moveDown(1);
      doc.fontSize(12).text(`Total Amount: $${totalAmount.toFixed(2)}`, {
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

      // For installments, display appropriate status
      if (order.paymentType === "installments" && installmentNumber) {
        // Find status of this specific installment
        const installmentStatus = getInstallmentStatus(
          order,
          installmentNumber
        );
        doc
          .fontSize(11)
          .text(`Payment Status: ${formatPaymentStatus(installmentStatus)}`);
      } else {
        doc
          .fontSize(11)
          .text(`Payment Status: ${formatPaymentStatus(order.paymentStatus)}`);
      }

      // Add installment details for installment plans
      if (order.paymentType === "installments") {
        doc.moveDown(1);
        doc.fontSize(10).text("Installment Plan Details:", { underline: true });

        const totalInstallments =
          order.installmentDetails?.numberOfInstallments || 0;
        const installmentAmount =
          order.installmentDetails?.installmentAmount || 0;
        const installmentsPaid =
          order.installmentDetails?.installmentsPaid || 0;

        doc.text(`Total Installments: ${totalInstallments}`);
        doc.text(`Installment Amount: $${installmentAmount.toFixed(2)}`);
        doc.text(
          `Installments Paid: ${installmentsPaid} of ${totalInstallments}`
        );

        // Add note for installment-specific receipts
        if (installmentNumber) {
          doc.moveDown(1);
          doc.fontSize(9).fillColor("#555555");
          doc.text(
            `Note: This receipt is for installment ${installmentNumber} of ${totalInstallments} only.`
          );
        } else if (paidOnly) {
          doc.moveDown(1);
          doc.fontSize(9).fillColor("#555555");
          doc.text("Note: This receipt includes only paid installments.");
        }

        doc.fillColor("black");
      }

      // Add footer
      doc.moveDown(3);
      const footerText =
        "www.donateSAF.com.au | syed.atif@shahidafridifoundation.org | +61 413 911 091";
      doc.fontSize(9).text(footerText, 50, 700, { align: "center" });

      // Finalize the PDF and end the stream
      doc.end();

      writeStream.on("finish", () => {
        resolve({ filePath, fileName, totalAmount });
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
 * Gets table data based on payment type and options
 * @param {Object} order - The order object
 * @param {Number} installmentNumber - Specific installment number to show
 * @param {Boolean} paidOnly - Only include paid items
 * @returns {Array} - Array of table row objects
 */
const getTableData = (order, installmentNumber, paidOnly) => {
  const tableData = [];
  const donationDate = formatDate(order.createdAt);

  // For installment plans
  if (order.paymentType === "installments") {
    // If looking for a specific installment
    if (installmentNumber && order.installmentDetails?.installmentHistory) {
      const installment = order.installmentDetails.installmentHistory.find(
        (item) => item.installmentNumber === installmentNumber
      );

      if (installment) {
        tableData.push({
          donation_date: formatDate(installment.date || order.createdAt),
          description: `Installment ${installmentNumber} of ${order.installmentDetails.numberOfInstallments}`,
          amount: `$${parseFloat(installment.amount).toFixed(2)}`,
        });
      }
    }
    // Show all paid installments
    else if (paidOnly && order.installmentDetails?.installmentHistory) {
      order.installmentDetails.installmentHistory
        .filter((item) => item.status === "completed")
        .forEach((item) => {
          tableData.push({
            donation_date: formatDate(item.date || order.createdAt),
            description: `Installment ${item.installmentNumber} of ${order.installmentDetails.numberOfInstallments}`,
            amount: `$${parseFloat(item.amount).toFixed(2)}`,
          });
        });
    }
    // Fallback to items if no installment history
    else if (order.items && order.items.length > 0) {
      order.items.forEach((item) => {
        tableData.push({
          donation_date: donationDate,
          description: `${item.title}${
            item.onBehalfOf ? ` (on behalf of ${item.onBehalfOf})` : ""
          }`,
          amount: `$${(item.price * (item.quantity || 1)).toFixed(2)}`,
        });
      });
    }
  }
  // For regular donations and recurring
  else {
    if (order.items && order.items.length > 0) {
      order.items.forEach((item) => {
        tableData.push({
          donation_date: donationDate,
          description: `${item.title}${
            item.onBehalfOf ? ` (on behalf of ${item.onBehalfOf})` : ""
          }`,
          amount: `$${(item.price * (item.quantity || 1)).toFixed(2)}`,
        });
      });
    }
  }

  // Add admin cost contribution if included
  if (order.adminCostContribution && order.adminCostContribution.included) {
    tableData.push({
      donation_date: donationDate,
      description: "Admin Cost Contribution",
      amount: `$${order.adminCostContribution.amount.toFixed(2)}`,
    });
  }

  return tableData;
};

/**
 * Get status of a specific installment
 * @param {Object} order - The order object
 * @param {Number} installmentNumber - The installment number to check
 * @returns {String} - Status of the installment
 */
const getInstallmentStatus = (order, installmentNumber) => {
  if (order.installmentDetails?.installmentHistory) {
    const installment = order.installmentDetails.installmentHistory.find(
      (item) => item.installmentNumber === installmentNumber
    );

    if (installment) {
      return installment.status || "unknown";
    }
  }

  return "unknown";
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
  if (address.country) parts.push(address.country);

  return parts.join(", ");
};

/**
 * Formats a date into YYYY-MM-DD format
 * @param {Date|string} date - The date to format
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
 * Gets the financial year string based on a date
 * @param {Date|string} date - The date to check
 * @returns {string} - Financial year string (e.g., "2024/2025")
 */
const getCurrentFinancialYear = (date) => {
  const d = date ? new Date(date) : new Date();
  const year = d.getFullYear();
  const month = d.getMonth() + 1; // 0-indexed

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
 * @param {Number} installmentNumber - Optional specific installment number
 * @param {Boolean} paidOnly - Only include paid items (for installments)
 * @returns {Promise<Object>} - Result of the email sending operation
 */
const sendReceiptEmail = async (
  order,
  installmentNumber = null,
  paidOnly = false
) => {
  try {
    // Generate the PDF receipt
    const { filePath, fileName, totalAmount } = await generateReceiptPDF(
      order,
      installmentNumber,
      paidOnly
    );

    // Create appropriate email subject based on payment type
    let emailSubject = `Shahid Afridi Foundation - `;

    if (order.paymentType === "installments" && installmentNumber) {
      emailSubject += `Installment ${installmentNumber} Receipt ${order.donationId}`;
    } else if (order.paymentType === "installments") {
      emailSubject += `Installment Payment Receipt ${order.donationId}`;
    } else if (order.paymentType === "recurring") {
      emailSubject += `Recurring Donation Receipt ${order.donationId}`;
    } else {
      emailSubject += `Donation Receipt ${order.donationId}`;
    }

    // Create email body
    const emailBody = createEmailBody(order, totalAmount, installmentNumber);

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
 * Creates the email body with appropriate messaging based on payment type
 * @param {Object} order - The order object
 * @param {Number} totalAmount - Total amount on the receipt
 * @param {Number} installmentNumber - Installment number (if applicable)
 * @returns {String} - HTML email body
 */
const createEmailBody = (order, totalAmount, installmentNumber) => {
  // Customize messaging based on payment type
  let paymentTypeMessage = "";
  let amountDescription = "";

  if (order.paymentType === "installments" && installmentNumber) {
    paymentTypeMessage = `installment ${installmentNumber} payment`;
    amountDescription = `Installment ${installmentNumber} Amount`;
  } else if (order.paymentType === "installments") {
    paymentTypeMessage = "installment payments";
    amountDescription = "Total Paid Amount";
  } else if (order.paymentType === "recurring") {
    paymentTypeMessage = "recurring donation";
    amountDescription = "Donation Amount";
  } else {
    paymentTypeMessage = "donation";
    amountDescription = "Donation Amount";
  }

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="text-align: center; padding: 20px 0;">
        <img src="https://safimages.s3.ap-southeast-2.amazonaws.com/events/Screenshot+2025-02-27+014744.png" alt="Shahid Afridi Foundation" style="max-width: 150px;">
      </div>
      
      <h2 style="color: #4a7c59;">Thank You for Your ${
        paymentTypeMessage.charAt(0).toUpperCase() + paymentTypeMessage.slice(1)
      }!</h2>
      
      <p>Dear ${order.donorDetails.name},</p>
      
      <p>Thank you for your generous ${paymentTypeMessage} to the Shahid Afridi Foundation. Your support helps us make a difference in the lives of those in need.</p>
      
      <div style="background-color: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
        <h3 style="margin-top: 0;">Receipt Details:</h3>
        <p><strong>Donation ID:</strong> ${order.donationId}</p>
        <p><strong>Date:</strong> ${formatDate(order.createdAt)}</p>
        <p><strong>${amountDescription}:</strong> $${totalAmount.toFixed(
    2
  )} AUD</p>
        <p><strong>Payment Method:</strong> ${formatPaymentMethod(
          order.paymentMethod
        )}</p>
        ${
          order.paymentType === "installments"
            ? `<p><strong>Payment Plan:</strong> ${
                order.installmentDetails?.numberOfInstallments || 0
              } installments</p>`
            : ""
        }
      </div>
      
      <p>Your official tax-deductible receipt is attached to this email. Please keep it for your tax records.</p>
      
      ${
        order.paymentMethod === "bank" ? getBankTransferInstructions(order) : ""
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
