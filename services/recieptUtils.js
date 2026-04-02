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
        width: 100,
      });

      doc.image(
        path.join(__dirname, "../public/images/tax-deductible.png"),
        450,
        45,
        { width: 100,
          height: 50
         }
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

      // Donation type(s): from items if present, else order-level
      const pdfItemTypes = order.items?.length
        ? [...new Set(order.items.map((i) => i.donationType).filter(Boolean))]
        : [];
      const pdfDonationType =
        pdfItemTypes.length > 0
          ? pdfItemTypes.join(", ")
          : order.donationTypeName || order.donationType || "Sadaqah";
      doc.text(`Donation Type: ${pdfDonationType}`);

      // Add donation table
      doc.moveDown(2);

      // Table header definition
      const headerData = {
        donation_date: "Donation Date",
        description: "Description",
        amount: "Donation Amount",
      };

      // Create table data based on payment type and options
      const tableData = getTableData(order, installmentNumber, paidOnly);
   
     // Draw table with separate header handling for better controlAdd commentMore actions
      let lastY = createTableWithSeparateHeader(
        doc,
        headerData,
        tableData,
        50,
        doc.y
      );

      // Calculate total amount
      let totalAmount = 0;
      tableData.forEach((row) => {
        totalAmount += parseFloat(row.amount.replace("$", ""));
      });
// Add total amount
      doc.y = lastY + 10;
      doc.fontSize(9)
      .text(`Total Amount: $ ${totalAmount}`);
     
      // Add payment details
      doc.moveDown(2);
      doc
        .fontSize(9)
        .text(`Payment Method: ${formatPaymentMethod(order.paymentMethod)}`);
      doc
        .fontSize(9)
        .text(`Payment Type: ${formatPaymentType(order.paymentType)}`);

      // For installments, display appropriate status
      if (order.paymentType === "installments" && installmentNumber) {
        // Find status of this specific installment
        const installmentStatus = getInstallmentStatus(
          order,
          installmentNumber
        );
        doc
          .fontSize(9)
          .text(`Payment Status: ${formatPaymentStatus(installmentStatus)}`);
      } else {
        doc
          .fontSize(9)
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

      // Add tax footer (must match the "My donations" receipt styling)
      const pageWidth = doc.page?.width || 595;
      const marginX = 50;
      const availableWidth = pageWidth - marginX * 2;

      // Tax Information heading
      doc.moveDown(1.5);
      doc.fontSize(9).fillColor("#008000").font("Helvetica").text("Tax Information", marginX, doc.y, {
        width: availableWidth,
        align: "center",
      });

      // Tax information text
      doc.moveDown(0.2);
      doc.fontSize(8).fillColor("#000000").font("Helvetica").text(
        "All donations are tax-deductible to the extent allowed by law.",
        marginX,
        doc.y,
        { width: availableWidth, align: "center" }
      );
      doc.moveDown(0.2);
      doc.fontSize(8).fillColor("#000000").font("Helvetica").text(
        "This receipt is for tax purposes only. Please retain for your records.",
        marginX,
        doc.y,
        { width: availableWidth, align: "center" }
      );

      // Separator line
      const lineY = doc.y + 14;
      doc.save();
      doc.strokeColor("#C8C8C8").lineWidth(0.5);
      doc
        .moveTo(marginX + 40, lineY)
        .lineTo(pageWidth - (marginX + 40), lineY)
        .stroke();
      doc.restore();

      // Fundraising Authority numbers
      doc.y = lineY + 18;
      doc.fontSize(7).fillColor("#646464").font("Helvetica").text(
        "Fundraising Authority",
        marginX,
        doc.y,
        { width: availableWidth, align: "center" }
      );
      doc.y = doc.y + 10;
      doc.fontSize(6.5).fillColor("#646464").font("Helvetica").text(
        " NSW: CFN26181 | VIC: FR0016494 | WA: CC23981 | QLD: CH4900307 | SA: CCP4771 | TAS: C/11569",
        marginX,
        doc.y,
        { width: availableWidth, align: "center" }
      );

      // Existing website/contact footer
      const footerText =
        "www.shahidafridifoundation.org.au | info@ShahidAfridiFoundation.org.au | 1300 SAF AUS (1300 723 287)";
      doc.moveDown(1.2);
      doc.fontSize(9).fillColor("#000000").text(footerText, marginX, doc.y, {
        width: availableWidth,
        align: "center",
      });

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
 * Generates a PDF statement for a financial year
 * @param {Object} statement - The statement data object
 * @param {string} userEmail - User's email for file naming
 * @returns {Promise<{filePath: string, fileName: string}>} - Path to the generated PDF
 */
const generateStatementPDF = async (statement, userEmail) => {
  const fs = require("fs");
  const path = require("path");

  // Create uploads directory if it doesn't exist
  const uploadsDir = path.join(__dirname, "../uploads/statements");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  // Generate unique filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sanitizedEmail = userEmail.replace(/[^a-zA-Z0-9]/g, "");
  let fileName = `statement-${statement.financialYear}-${sanitizedEmail}-${timestamp}`;
  fileName += ".pdf";

  const filePath = path.join(uploadsDir, fileName);

  const doc = new PDFDocument({ margin: 50 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const marginLeft = 50;
  const marginRight = 50;
  const pageWidth = doc.page?.width || 595;
  const contentWidth = pageWidth - marginLeft - marginRight;

  // Logos
  const logoPath = path.join(__dirname, "../public/images/logo.png");
  const taxLogoPath = path.join(
    __dirname,
    "../public/images/tax-deductible.png"
  );
  const leftLogoX = marginLeft;
  const leftLogoY = 18;
  const leftLogoWidth = 62;
  const leftLogoHeight = 45;
  const rightLogoY = 18;
  const rightLogoWidth = 90;
  const rightLogoHeight = 45;

  if (fs.existsSync(logoPath)) {
    // Move logo up to avoid overlapping the header title.
    doc.image(logoPath, leftLogoX, leftLogoY, {
      width: leftLogoWidth,
      height: leftLogoHeight,
    });
  }
  if (fs.existsSync(taxLogoPath)) {
    doc.image(taxLogoPath, pageWidth - marginRight - rightLogoWidth, rightLogoY, {
      width: rightLogoWidth,
      height: rightLogoHeight,
    });
  }

  const [startYear, endYear] = (statement.financialYear || "").split("-");

  // Header (match frontend look)
  // Header top baseline (tuned to sit below logos).
  const titleY = leftLogoY + leftLogoHeight + 12;
  let y = titleY;
  doc.fontSize(16).font("Helvetica-Bold").fillColor("#000000");
  doc.text("Shahid Afridi Foundation Ltd", marginLeft, y, {
    width: contentWidth,
    align: "left",
  });
  y += 18;

  doc.fontSize(12).font("Helvetica").fillColor("#000000");
  doc.text("Annual Donation Statement", marginLeft, y, {
    width: contentWidth,
    align: "left",
  });
  y += 16;

  doc.fontSize(10).font("Helvetica").fillColor("#000000");
  doc.text(
    `Financial Year: July 1, ${startYear} - June 30, ${endYear}`,
    marginLeft,
    y,
    { width: contentWidth, align: "left" }
  );

  // Right-side info (ABN / Date issued / Reference)
  const rightX = marginLeft;
  const rightWidth = contentWidth;
  const dateIssued = formatDate(new Date());
  doc.fontSize(10).font("Helvetica").fillColor("#000000");
  doc.text("ABN: 97 642 657 010", rightX, titleY, {
    width: rightWidth,
    align: "right",
  });
  doc.text(`Date Issued: ${dateIssued}`, rightX, titleY + 12, {
    width: rightWidth,
    align: "right",
  });
  if (statement.statementId) {
    doc.text(`Reference: ${statement.statementId}`, rightX, titleY + 24, {
      width: rightWidth,
      align: "right",
    });
  }

  // Donor info
  y += 26;
  doc.fontSize(10).font("Helvetica").fillColor("#000000");
  doc.text(`Name: ${statement.user?.name || "N/A"}`, marginLeft, y, {
    width: contentWidth,
    align: "left",
  });
  y += 12;
  doc.text(`Email: ${statement.user?.email || "N/A"}`, marginLeft, y, {
    width: contentWidth,
    align: "left",
  });

  // Build table rows (6 columns)
  const tableRows = [];
  const pushRow = ({
    donationDate,
    donationId,
    description,
    paymentType,
    donationType,
    amount,
  }) => {
    if (!donationDate) return;
    tableRows.push({
      donation_date: formatDate(donationDate),
      donation_id: (donationId || "").toString(),
      description: (description || "").toString(),
      payment_type: (paymentType || "").toString(),
      donation_type: (donationType || "").toString(),
      amount: `$${Number(amount || 0).toFixed(2)}`,
    });
  };

  const donationTitleFromItems = (items) => {
    const first = Array.isArray(items) && items.length ? items[0] : null;
    return first?.title || first?.description || "Donation";
  };

  const donationTypeFromPayment = (payment) => {
    const fromItems =
      payment?.items && payment.items.length
        ? payment.items[0]?.donationType || payment.items[0]?.donationTypeName
        : null;
    return payment?.donationType || fromItems || "Sadaqah";
  };

  // One-time
  (statement.breakdown?.oneTimePayments || []).forEach((payment) => {
    const donationId = payment.donationId || "";
    const description = donationTitleFromItems(payment.items) || "";
    const donationType = donationTypeFromPayment(payment);
    const hist = payment.paymentHistory || [];
    if (hist.length) {
      hist.forEach((h) =>
        pushRow({
          donationDate: h.date,
          donationId,
          description,
          paymentType: "One-time",
          donationType,
          amount: h.amount,
        })
      );
    } else {
      pushRow({
        donationDate: payment.createdAt,
        donationId,
        description,
        paymentType: "One-time",
        donationType,
        amount: payment.actualPayments,
      });
    }
  });

  // Recurring
  (statement.breakdown?.recurringPayments || []).forEach((payment) => {
    const donationId = payment.donationId || "";
    const description = donationTitleFromItems(payment.items) || "";
    const donationType = donationTypeFromPayment(payment);
    const hist = payment.paymentHistory || [];
    if (hist.length) {
      hist.forEach((h) =>
        pushRow({
          donationDate: h.date,
          donationId,
          description,
          paymentType: "Recurring",
          donationType,
          amount: h.amount,
        })
      );
    } else {
      pushRow({
        donationDate: payment.createdAt,
        donationId,
        description,
        paymentType: "Recurring",
        donationType,
        amount: payment.actualPayments,
      });
    }
  });

  // Installments
  (statement.breakdown?.installmentPayments || []).forEach((payment) => {
    const donationId = payment.donationId || "";
    const donationType = donationTypeFromPayment(payment);
    const baseTitle = donationTitleFromItems(payment.items) || "";
    const hist = payment.paymentHistory || [];
    if (hist.length) {
      hist.forEach((h) =>
        pushRow({
          donationDate: h.date,
          donationId,
          description:
            h.installmentNumber != null
              ? `${baseTitle} - Installment ${h.installmentNumber}`
              : baseTitle,
          paymentType: "Installment",
          donationType,
          amount: h.amount,
        })
      );
    } else {
      pushRow({
        donationDate: payment.createdAt,
        donationId,
        description: baseTitle,
        paymentType: "Installment",
        donationType,
        amount: payment.actualPayments,
      });
    }
  });

  // P2P
  (statement.breakdown?.p2pDonations || []).forEach((donation) => {
    pushRow({
      donationDate: donation.createdAt,
      donationId: donation.donationId || "",
      description: `P2P Campaign: ${donation.campaignTitle || "Campaign"}`,
      paymentType: "P2P Campaign",
      donationType: donation.donationType || "P2P",
      amount: donation.amount,
    });
  });

  // Sort by date asc
  tableRows.sort(
    (a, b) => new Date(a.donation_date) - new Date(b.donation_date)
  );

  const tableHeader = {
    donation_date: "Donation Date",
    donation_id: "Donation ID",
    description: "Description",
    payment_type: "Payment Type",
    donation_type: "Donation Type",
    amount: "Amount",
  };

  const tableStartY = y + 18;
  const lastTableY = createAnnualStatementTable(
    doc,
    tableHeader,
    tableRows,
    marginLeft,
    tableStartY
  );

  // Total amount (right)
  const totalAmount = Number(statement.summary?.totalAmount || 0);
  const totalText = `Total Amount: $${totalAmount.toFixed(2)}`;

  // Place total + tax/footer near the bottom using fixed Y coordinates.
  // This prevents overlap with the last table rows (what you’re seeing).
  const pageHeight = doc.page?.height || 842;
  const bottomPadding = 35;
  const footerBlockHeight = 105; // tax heading + body + authority + site footer
  const footerStartY = pageHeight - bottomPadding - footerBlockHeight;
  const totalY = footerStartY - 18;

  // If the table ended too low, put the footer on a new page (no overlap).
  const minSpacingAfterTable = 10;
  if (lastTableY + minSpacingAfterTable > totalY) {
    doc.addPage();
  }

  const pageHeight2 = doc.page?.height || 842;
  const footerStartY2 = pageHeight2 - bottomPadding - footerBlockHeight;
  const totalY2 = footerStartY2 - 18;

  doc.fontSize(10).font("Helvetica-Bold").fillColor("#000000");
  doc.text(totalText, marginLeft, totalY2, { width: contentWidth, align: "right" });

  // Tax footer (match frontend)
  doc.fontSize(9).font("Helvetica-Bold").fillColor("#008000");
  doc.text("Tax Information", marginLeft, footerStartY2, {
    width: contentWidth,
    align: "center",
  });

  doc.fontSize(8).font("Helvetica").fillColor("#000000");
  const line1Y = footerStartY2 + 12;
  doc.text(
    "All donations are tax-deductible to the extent allowed by law.",
    marginLeft,
    line1Y,
    { width: contentWidth, align: "center" }
  );

  const line2Y = line1Y + 10;
  doc.text(
    "This statement is for tax purposes only. Please retain for your records.",
    marginLeft,
    line2Y,
    { width: contentWidth, align: "center" }
  );

  const fundraisingY = line2Y + 18;
  doc.text(
    "Fundraising Authority",
    marginLeft,
    fundraisingY,
    { width: contentWidth, align: "center" }
  );

  const fundraisingNumsY = fundraisingY + 10;
  doc.fontSize(7).fillColor("#646464").font("Helvetica");
  doc.text(
    " NSW: CFN26181 | VIC: FR0016494 | WA: CC23981 | QLD: CH4900307 | SA: CCP4771 | TAS: C/11569",
    marginLeft,
    fundraisingNumsY,
    { width: contentWidth, align: "center" }
  );

  doc.fontSize(8).fillColor("#000000").font("Helvetica");
  const websiteY = pageHeight2 - bottomPadding;
  doc.text(
    "www.shahidafridifoundation.org.au | info@ShahidAfridiFoundation.org.au | 1300 SAF AUS (1300 723 287)",
    marginLeft,
    websiteY,
    { width: contentWidth, align: "center" }
  );

  // Finalize
  doc.end();

  return new Promise((resolve, reject) => {
    stream.on("finish", () => {
      resolve({ filePath, fileName });
    });
    stream.on("error", reject);
  });
};

/**
 * Annual donor financial statement table (6 columns)
 * Designed to match the frontend jsPDF/autoTable layout: multi-line description with proper borders.
 */
const createAnnualStatementTable = (doc, headerData, bodyData, x, y) => {
  const pageWidth = doc.page?.width || 595;
  const contentWidth = pageWidth - x * 2;

  // 6 columns total width = contentWidth
  const colWidths = {
    donation_date: contentWidth * 0.13,
    donation_id: contentWidth * 0.13,
    description: contentWidth * 0.30,
    payment_type: contentWidth * 0.14,
    donation_type: contentWidth * 0.12,
    amount: contentWidth * 0.18,
  };

  const totalWidth =
    colWidths.donation_date +
    colWidths.donation_id +
    colWidths.description +
    colWidths.payment_type +
    colWidths.donation_type +
    colWidths.amount;

  // Column x positions
  const colX = {
    donation_date: x,
    donation_id: x + colWidths.donation_date,
    description:
      x + colWidths.donation_date + colWidths.donation_id,
    payment_type:
      x + colWidths.donation_date + colWidths.donation_id + colWidths.description,
    donation_type:
      x + colWidths.donation_date + colWidths.donation_id + colWidths.description + colWidths.payment_type,
    amount:
      x +
      colWidths.donation_date +
      colWidths.donation_id +
      colWidths.description +
      colWidths.payment_type +
      colWidths.donation_type,
  };

  const headerHeight = 18;
  const minRowHeight = 16;

  const drawHeader = (headerY) => {
    doc.fillColor("#f0f0f0").rect(x, headerY, totalWidth, headerHeight).fill();
    doc.fillColor("#000000");
    doc.font("Helvetica-Bold").fontSize(8);

    const textY = headerY + headerHeight / 2 - 4;
    doc.text(headerData.donation_date, colX.donation_date + 3, textY, {
      width: colWidths.donation_date - 6,
    });
    doc.text(headerData.donation_id, colX.donation_id + 3, textY, {
      width: colWidths.donation_id - 6,
    });
    doc.text(headerData.description, colX.description + 3, textY, {
      width: colWidths.description - 6,
    });
    doc.text(headerData.payment_type, colX.payment_type + 3, textY, {
      width: colWidths.payment_type - 6,
    });
    doc.text(headerData.donation_type, colX.donation_type + 3, textY, {
      width: colWidths.donation_type - 6,
    });
    doc.text(headerData.amount, colX.amount + 3, textY, {
      width: colWidths.amount - 6,
      align: "right",
    });

    // Borders
    doc.lineWidth(0.5).strokeColor("#000000");
    doc.rect(x, headerY, totalWidth, headerHeight).stroke();

    // Vertical dividers
    const lines = [
      x + colWidths.donation_date,
      x + colWidths.donation_date + colWidths.donation_id,
      x + colWidths.donation_date + colWidths.donation_id + colWidths.description,
      x +
        colWidths.donation_date +
        colWidths.donation_id +
        colWidths.description +
        colWidths.payment_type,
      x +
        colWidths.donation_date +
        colWidths.donation_id +
        colWidths.description +
        colWidths.payment_type +
        colWidths.donation_type,
    ];
    lines.forEach((lx) => {
      doc.moveTo(lx, headerY).lineTo(lx, headerY + headerHeight).stroke();
    });

    return headerY + headerHeight;
  };

  let currentY = y;
  currentY = drawHeader(currentY);

  const bottomLimit =
    (doc.page?.height || 842) - doc.page.margins.bottom;

  for (const row of bodyData) {
    // Wrap height for description
    doc.font("Helvetica").fontSize(8);
    const descHeight = doc.heightOfString(row.description || "", {
      width: colWidths.description - 6,
    });
    const rowHeight = Math.max(minRowHeight, descHeight + 6);

    if (currentY + rowHeight > bottomLimit) {
      doc.addPage();
      currentY = doc.page.margins.top;
      currentY = drawHeader(currentY);
    }

    // Cell borders
    doc.lineWidth(0.5).strokeColor("#000000");
    doc.rect(x, currentY, totalWidth, rowHeight).stroke();

    // Vertical dividers
    const dividerXs = [
      x + colWidths.donation_date,
      x + colWidths.donation_date + colWidths.donation_id,
      x + colWidths.donation_date + colWidths.donation_id + colWidths.description,
      x +
        colWidths.donation_date +
        colWidths.donation_id +
        colWidths.description +
        colWidths.payment_type,
      x +
        colWidths.donation_date +
        colWidths.donation_id +
        colWidths.description +
        colWidths.payment_type +
        colWidths.donation_type,
    ];
    dividerXs.forEach((lx) => {
      doc.moveTo(lx, currentY).lineTo(lx, currentY + rowHeight).stroke();
    });

    const textXPad = 3;
    const textYPad = 4;

    doc.font("Helvetica").fontSize(8);
    doc.text(row.donation_date || "", colX.donation_date + textXPad, currentY + textYPad, {
      width: colWidths.donation_date - 6,
    });
    doc.text(row.donation_id || "", colX.donation_id + textXPad, currentY + textYPad, {
      width: colWidths.donation_id - 6,
    });
    doc.text(row.description || "", colX.description + textXPad, currentY + textYPad, {
      width: colWidths.description - 6,
    });
    doc.text(row.payment_type || "", colX.payment_type + textXPad, currentY + textYPad, {
      width: colWidths.payment_type - 6,
    });
    doc.text(row.donation_type || "", colX.donation_type + textXPad, currentY + textYPad, {
      width: colWidths.donation_type - 6,
    });
    doc.text(row.amount || "", colX.amount + textXPad, currentY + textYPad, {
      width: colWidths.amount - 6,
      align: "right",
    });

    currentY += rowHeight;
  }

  return currentY;
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
        const donationType = item.donationType || order.donationTypeName || order.donationType || 'Sadaqah';
        const typeInfo = donationType ? ` [${donationType}]` : '';
        tableData.push({
          donation_date: donationDate,
          description: `${item.title}${typeInfo}${
            item.onBehalfOf ? ` - on behalf of ${item.onBehalfOf}` : ""
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
        const donationType = item.donationType || order.donationTypeName || order.donationType || 'Sadaqah';
        const typeInfo = donationType ? ` [${donationType}]` : '';
        tableData.push({
          donation_date: donationDate,
          description: `${item.title}${typeInfo}${
            item.onBehalfOf ? ` - on behalf of ${item.onBehalfOf}` : ""
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
 * Creates a table in the PDF with better row handling
 * @param {PDFDocument} doc - The PDF document
 * @param {Array} data - Array of objects containing row data
 * @param {number} x - X position
 * @param {number} y - Y position
 * @returns {number} - The new Y position after drawing the table
 */
const createTable = (doc, data, x, y) => {
  // Set column widths
  const dateColWidth = 100;
  const descColWidth = 280;
  const amountColWidth = 100;
  const totalWidth = dateColWidth + descColWidth + amountColWidth;

  // Initial y position
  let currentY = y;

  // Detect if this contains header row
  const hasHeader =
    data.length > 0 && data[0].donation_date === "Donation Date";

  // Draw header row (if present)
  if (hasHeader) {
    // Fixed header height
    const headerHeight = 25;

    // Draw header background
    doc
      .fillColor("#f5f5f5")
      .rect(x, currentY, totalWidth, headerHeight)
      .fill()
      .fillColor("black");

    // Draw header text with consistent positioning
    doc.font("Helvetica-Bold").fontSize(9);

    // Center text vertically in header cells
    const textY = currentY + headerHeight / 2 - 4;

    // Date column
    doc.text(data[0].donation_date, x + 5, textY, {
      width: dateColWidth - 10,
      align: "left",
    });

    // Description column
    doc.text(data[0].description, x + dateColWidth + 5, textY, {
      width: descColWidth - 10,
      align: "left",
    });

    // Amount column
    doc.text(data[0].amount, x + dateColWidth + descColWidth + 5, textY, {
      width: amountColWidth - 10,
      align: "left",
    });

    // Reset font
    doc.font("Helvetica");

    // Draw border around header
    doc.lineWidth(0.5).rect(x, currentY, totalWidth, headerHeight).stroke();

    // Draw vertical lines for columns
    doc
      .moveTo(x + dateColWidth, currentY)
      .lineTo(x + dateColWidth, currentY + headerHeight)
      .stroke();

    doc
      .moveTo(x + dateColWidth + descColWidth, currentY)
      .lineTo(x + dateColWidth + descColWidth, currentY + headerHeight)
      .stroke();

    // Move position down
    currentY += headerHeight;

    // If only header row, return current position
    if (data.length === 1) {
      return currentY;
    }

    // Remove header from data for processing rows
    data = data.slice(1);
  }

  // Process data rows
  for (const row of data) {
    // Calculate height needed for description
    const descriptionHeight = doc.fontSize(9).heightOfString(row.description, {
      width: descColWidth - 10,
    });

    // Ensure minimum row height (25 pixels) or more if needed
    const rowHeight = Math.max(25, descriptionHeight + 10);

    // Draw cell content with consistent positioning
    doc.fontSize(9);

    // Date column (vertically aligned to top with padding)
    doc.text(row.donation_date, x + 5, currentY + 5, {
      width: dateColWidth - 10,
    });

    // Description column
    doc.text(row.description, x + dateColWidth + 5, currentY + 5, {
      width: descColWidth - 10,
    });

    // Amount column
    doc.text(row.amount, x + dateColWidth + descColWidth + 5, currentY + 5, {
      width: amountColWidth - 10,
      align: "right",
    });

    // Draw full cell borders
    doc.lineWidth(0.5).rect(x, currentY, totalWidth, rowHeight).stroke();

    // Draw vertical dividers
    doc
      .moveTo(x + dateColWidth, currentY)
      .lineTo(x + dateColWidth, currentY + rowHeight)
      .stroke();

    doc
      .moveTo(x + dateColWidth + descColWidth, currentY)
      .lineTo(x + dateColWidth + descColWidth, currentY + rowHeight)
      .stroke();

    // Update position for next row
    currentY += rowHeight;
  }

  return currentY;
};

/**
 * Creates separate header and data sections for better control
 * @param {PDFDocument} doc - The PDF document
 * @param {Object} headerData - Header row data
 * @param {Array} bodyData - Data rows
 * @param {number} x - X position
 * @param {number} y - Y position
 * @returns {number} - The new Y position after drawing the table
 */
const createTableWithSeparateHeader = (doc, headerData, bodyData, x, y) => {
  // Set column widths
  const dateColWidth = 100;
  const descColWidth = 280;
  const amountColWidth = 100;
  const totalWidth = dateColWidth + descColWidth + amountColWidth;

  // Initial y position
  let currentY = y;

  // Fixed header height
  const headerHeight = 25;

  const topMargin = doc.page?.margins?.top ?? 50;
  const bottomMargin = doc.page?.margins?.bottom ?? 50;

  const drawHeader = (headerY) => {
    // Draw header background
    doc
      .fillColor("#f5f5f5")
      .rect(x, headerY, totalWidth, headerHeight)
      .fill()
      .fillColor("black");

    // Draw header text with consistent positioning
    doc.font("Helvetica-Bold").fontSize(9);

    // Vertically position text in header cells
    const headerTextY = headerY + headerHeight / 2 - 4;

    // Date column
    doc.text(headerData.donation_date, x + 5, headerTextY, {
      width: dateColWidth - 10,
      align: "left",
    });

    // Description column
    doc.text(headerData.description, x + dateColWidth + 5, headerTextY, {
      width: descColWidth - 10,
      align: "left",
    });

    // Amount column
    doc.text(headerData.amount, x + dateColWidth + descColWidth + 5, headerTextY, {
      width: amountColWidth - 10,
      align: "right",
    });

    // Reset font
    doc.font("Helvetica");

    // Draw border around header
    doc.lineWidth(0.5).rect(x, headerY, totalWidth, headerHeight).stroke();

    // Draw vertical lines for columns
    doc
      .moveTo(x + dateColWidth, headerY)
      .lineTo(x + dateColWidth, headerY + headerHeight)
      .stroke();

    doc
      .moveTo(x + dateColWidth + descColWidth, headerY)
      .lineTo(x + dateColWidth + descColWidth, headerY + headerHeight)
      .stroke();

    // Return y after header
    return headerY + headerHeight;
  };

  // Draw header for first page
  currentY = drawHeader(currentY);

  // Process data rows
  for (const row of bodyData) {
    // Calculate height needed for description
    const descriptionHeight = doc.fontSize(9).heightOfString(row.description, {
      width: descColWidth - 10,
    });

    // Ensure minimum row height (25 pixels) or more if needed
    const rowHeight = Math.max(25, descriptionHeight + 10);

    // Page break handling: if this row doesn't fit, add page and redraw header
    const pageBottomLimit = doc.page.height - bottomMargin;
    if (currentY + rowHeight > pageBottomLimit) {
      doc.addPage();
      // Start new table section on the new page
      currentY = drawHeader(topMargin);
    }

    // Draw cell content with consistent positioning
    doc.fontSize(9);

    // Date column (vertically aligned to top with padding)
    doc.text(row.donation_date, x + 5, currentY + 5, {
      width: dateColWidth - 10,
    });

    // Description column
    doc.text(row.description, x + dateColWidth + 5, currentY + 5, {
      width: descColWidth - 10,
    });

    // Amount column
    doc.text(row.amount, x + dateColWidth + descColWidth + 5, currentY + 5, {
      width: amountColWidth - 10,
      align: "right",
    });

    // Draw full cell borders
    doc.lineWidth(0.5).rect(x, currentY, totalWidth, rowHeight).stroke();

    // Draw vertical dividers
    doc
      .moveTo(x + dateColWidth, currentY)
      .lineTo(x + dateColWidth, currentY + rowHeight)
      .stroke();

    doc
      .moveTo(x + dateColWidth + descColWidth, currentY)
      .lineTo(x + dateColWidth + descColWidth, currentY + rowHeight)
      .stroke();

    // Update position for next row
    currentY += rowHeight;
  }

  return currentY;
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
    eftpos: "EFTPOS",
    paypal: "PayPal",
    visa: "Visa",
    mastercard: "Mastercard",
    amex: "American Express",
    discover: "Discover",
    stripe: "Credit/Debit Card", // fallback for legacy data
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
    active: "Active",
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

  // Donation type(s): from items if present, else order-level
  const itemTypes = order.items?.length
    ? [...new Set(order.items.map((i) => i.donationType).filter(Boolean))]
    : [];
  const donationTypeDisplay =
    itemTypes.length > 0
      ? itemTypes.join(", ")
      : order.donationTypeName || order.donationType || "Sadaqah";

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
        <p><strong>Donation Type:</strong> ${donationTypeDisplay}</p>
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
        order.paymentMethod === "bank" ? getBankTransferInstructions(order) : 
        order.paymentMethod === "eftpos" ? getEFTPOSInstructions(order) : ""
      }
      
      <p>If you have any questions or need further assistance, please don't hesitate to contact us at <a href="mailto:info@ShahidAfridiFoundation.org.au">info@ShahidAfridiFoundation.org.au</a> or call us at 1300 SAF AUS (1300 723 287).</p>
      
      <p>Warm regards,<br>
      Shahid Afridi Foundation Team</p>
      
      <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #777;">
        <p>Shahid Afridi Foundation Ltd | ABN: 97 642 657 010<br>
        <a href="http://www.shahidafridifoundation.org.au/">www.shahidafridifoundation.org.au</a> | <a href="mailto:info@ShahidAfridiFoundation.org.au">info@ShahidAfridiFoundation.org.au</a> | 1300 SAF AUS (1300 723 287)</p>
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

/**
 * Gets EFTPOS instructions for email body
 * @param {Object} order - The order object
 * @returns {string} - HTML string with EFTPOS instructions
 */
const getEFTPOSInstructions = (order) => {
  return `
    <div style="background-color: #fffaed; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #ffc107;">
      <h3 style="margin-top: 0; color: #856404;">EFTPOS Payment Instructions:</h3>
      <p>Please upload your EFTPOS receipt so our team can confirm your payment.</p>
      <p>You can upload the receipt by logging into your account and visiting the "My Donations" page, or email it to us at <a href="mailto:info@ShahidAfridiFoundation.org.au">info@ShahidAfridiFoundation.org.au</a></p>
      <p><strong>Reference:</strong> ${order.donationId} (Please include this in your email subject if sending via email)</p>
      <p><strong>Note:</strong> Your donation will be marked as completed once we receive and verify your payment proof.</p>
    </div>
  `;
};

module.exports = { generateReceiptPDF, sendReceiptEmail, generateStatementPDF };
