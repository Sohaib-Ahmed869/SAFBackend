// Server-side annual donation statement PDF generator.
//
// This is a faithful port of the client-side generator in
// SAFFE/src/User/Screens/AnnualDonation.jsx (`generateAnnualStatement`).
// It uses the SAME libraries (jsPDF + jspdf-autotable), the SAME layout
// numbers, the SAME deterministic reference (`AS-<startYear>-<endYear>-<id>`),
// and the SAME Australia/Sydney date formatting so that a statement produced
// here is visually identical to the one a donor downloads from the dashboard.
//
// Keep this in sync with AnnualDonation.jsx — if the user-side template
// changes, mirror the change here.

const fs = require("fs");
const path = require("path");
const { jsPDF } = require("jspdf");
// jspdf-autotable exports the apply function as default under CJS interop.
const autoTableModule = require("jspdf-autotable");
const autoTable = autoTableModule.default || autoTableModule;

// Mirrors STATEMENT_SKIP_LIFETIME_FALLBACK_DONATION_IDS in orderContrller.js
// and AnnualDonation.jsx.
const STATEMENT_SKIP_LIFETIME_FALLBACK_DONATION_IDS = new Set(["95955433"]);

// Fixed timezone for every printed date — keeps the same donation on the same
// calendar date regardless of who downloads the statement.
const STATEMENT_TIME_ZONE = "Australia/Sydney";

// YYYY-MM-DD in STATEMENT_TIME_ZONE (matches AnnualDonation.jsx formatDate).
const formatDate = (date) => {
  if (!date) return "";
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: STATEMENT_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch (error) {
    console.error("Error formatting date:", error);
    return "";
  }
};

const formatCurrency = (amount) =>
  Number(amount || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// AS-<startYear>-<endYear>-<last 6 alphanumerics of userId, upper>
const generateUniqueStatementId = (year, userId) => {
  const raw = (userId || "").toString().replace(/[^a-zA-Z0-9]/g, "");
  const userIdPart = raw ? raw.slice(-6).toUpperCase() : "GUEST0";
  return `AS-${year - 1}-${year}-${userIdPart}`;
};

// Load a logo from public/images as a base64 data URI for jsPDF.addImage.
// Returns null if the file is missing (PDF still renders, just without the logo).
const loadImageDataUri = (fileName) => {
  try {
    const filePath = path.join(__dirname, "..", "public", "images", fileName);
    const buf = fs.readFileSync(filePath);
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch (err) {
    console.warn(`[StatementPDF] Could not load logo ${fileName}:`, err.message);
    return null;
  }
};

/**
 * Build the table rows + total from raw Order documents and P2P donations,
 * using the EXACT same logic as AnnualDonation.jsx so the output matches the
 * donor-facing PDF row-for-row (Recurring Payment 1/2..., Installment N of M, etc.).
 *
 * @param {Array} donations  - Mongoose Order documents (plain objects ok)
 * @param {Array} p2pDonations - normalized P2P donations
 * @param {number} year - the END year of the financial year (FY 2024-2025 -> 2025)
 * @returns {{ tableData: Array, totalDonated: number }}
 */
const buildStatementRows = (donations, p2pDonations, year) => {
  const startDate = new Date(`${year - 1}-07-01`);
  const endDate = new Date(`${year}-06-30`);

  const isInRange = (date) => {
    const d = new Date(date);
    return d >= startDate && d <= endDate;
  };

  // Filter regular donations for the FY (same rules as the client).
  const financialYearDonations = donations.filter((donation) => {
    if (donation.paymentStatus === "cancelled") return false;

    if (donation.paymentType === "recurring") {
      const history = donation.recurringDetails?.paymentHistory || [];
      const hasInFY = history.some(
        (p) =>
          (p.status === "succeeded" || p.status === "completed") &&
          isInRange(p.date)
      );
      if (hasInFY) return true;
      return isInRange(donation.createdAt);
    }

    if (donation.paymentType === "installments") {
      const history = donation.installmentDetails?.installmentHistory || [];
      const hasInFY = history.some(
        (i) => i.status === "completed" && isInRange(i.date || donation.createdAt)
      );
      if (hasInFY) return true;
      return isInRange(donation.createdAt);
    }

    // One-time donations: filter by createdAt.
    return isInRange(donation.createdAt);
  });

  const financialYearP2PDonations = (p2pDonations || []).filter((donation) => {
    return isInRange(donation.createdAt) && donation.paymentStatus === "completed";
  });

  const tableData = [];

  const sortedDonations = [...financialYearDonations].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
  );
  const sortedP2PDonations = [...financialYearP2PDonations].sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
  );

  sortedDonations.forEach((donation) => {
    const donationId =
      donation.donationId ||
      (donation._id ? donation._id.toString().slice(-8) : "");
    const donationType =
      donation.donationTypeName ||
      donation.donationType ||
      donation.items?.[0]?.donationType ||
      "Sadaqah";

    if (
      donation.paymentType === "installments" &&
      donation.installmentDetails?.installmentHistory
    ) {
      donation.installmentDetails.installmentHistory
        .filter((installment) => installment.status === "completed")
        .forEach((installment) => {
          const installmentAmount = parseFloat(installment.amount);
          tableData.push({
            donation_date: formatDate(installment.date || donation.createdAt),
            donation_id: donationId,
            description: `Installment ${installment.installmentNumber} of ${donation.installmentDetails.numberOfInstallments}: ${donation.items[0]?.title || "Donation"}`,
            payment_type: "Installment",
            donation_type: donationType,
            amount: `$${installmentAmount.toFixed(2)}`,
          });
        });
    } else if (donation.paymentType === "recurring") {
      const allHistory = donation.recurringDetails?.paymentHistory || [];
      const successful = allHistory.filter(
        (p) => p.status === "succeeded" || p.status === "completed"
      );
      let toRender = successful.filter((p) => {
        const d = new Date(p.date || donation.createdAt);
        return d >= startDate && d <= endDate;
      });
      if (
        toRender.length === 0 &&
        successful.length > 0 &&
        !STATEMENT_SKIP_LIFETIME_FALLBACK_DONATION_IDS.has(donation.donationId)
      ) {
        toRender = successful;
      }

      if (toRender.length > 0) {
        toRender.forEach((payment, index) => {
          const paymentAmount = payment.amount || donation.recurringDetails.amount;
          tableData.push({
            donation_date: formatDate(payment.date || donation.createdAt),
            donation_id: donationId,
            description: `Recurring Payment ${index + 1}: ${donation.items[0]?.title || "Recurring Donation"}`,
            payment_type: "Recurring",
            donation_type: donationType,
            amount: `$${formatCurrency(paymentAmount)}`,
          });
        });
      } else if (
        donation.paymentStatus === "active" ||
        donation.paymentStatus === "completed" ||
        donation.paymentStatus === "ended"
      ) {
        const amount = donation.recurringDetails?.amount || donation.totalAmount;
        tableData.push({
          donation_date: formatDate(donation.createdAt),
          donation_id: donationId,
          description: `Recurring Payment 1: ${donation.items[0]?.title || "Recurring Donation"}`,
          payment_type: "Recurring",
          donation_type: donationType,
          amount: `$${formatCurrency(amount)}`,
        });
      }
    } else {
      // One-time donations
      if (donation.items && donation.items.length > 0) {
        donation.items.forEach((item) => {
          let description = item.title;
          if (item.onBehalfOf) {
            description += ` (on behalf of ${item.onBehalfOf})`;
          }
          const adminCost = donation.adminCostContribution?.included
            ? donation.adminCostContribution.amount
            : 0;
          const itemTotal = item.price * (item.quantity || 1) + adminCost;
          tableData.push({
            donation_date: formatDate(donation.createdAt),
            donation_id: donationId,
            description,
            payment_type: "One-time",
            donation_type: donationType,
            amount: `$${formatCurrency(itemTotal)}`,
          });
        });
      }
    }
  });

  sortedP2PDonations.forEach((donation) => {
    const donationId =
      donation.donationId ||
      (donation._id ? donation._id.toString().slice(-8) : "");
    const campaignTitle = donation.goFundMe?.title || "Campaign Donation";
    const amount = donation.totalAmount || donation.amount || 0;
    const p2pDonationType = donation.donationType || "P2P";
    tableData.push({
      donation_date: formatDate(donation.createdAt),
      donation_id: donationId,
      description: `P2P Campaign: ${campaignTitle}`,
      payment_type: "P2P Campaign",
      donation_type: p2pDonationType,
      amount: `$${formatCurrency(amount)}`,
    });
  });

  // Total — mirror the row-rendering logic so the printed total matches the rows.
  const totalDonated =
    financialYearDonations.reduce((sum, donation) => {
      if (
        donation.paymentType === "installments" &&
        donation.installmentDetails?.installmentHistory
      ) {
        const completedInstallments =
          donation.installmentDetails.installmentHistory.filter((installment) => {
            const installmentDate = new Date(installment.date || donation.createdAt);
            return (
              installment.status === "completed" &&
              installmentDate >= startDate &&
              installmentDate <= endDate
            );
          });
        return (
          sum +
          completedInstallments.reduce((total, i) => total + i.amount, 0)
        );
      } else if (donation.paymentType === "recurring") {
        const allHistory = donation.recurringDetails?.paymentHistory || [];
        const successful = allHistory.filter(
          (p) => p.status === "succeeded" || p.status === "completed"
        );
        let toCount = successful.filter((p) => {
          const d = new Date(p.date || donation.createdAt);
          return d >= startDate && d <= endDate;
        });
        if (
          toCount.length === 0 &&
          successful.length > 0 &&
          !STATEMENT_SKIP_LIFETIME_FALLBACK_DONATION_IDS.has(donation.donationId)
        ) {
          toCount = successful;
        }
        if (toCount.length > 0) {
          return (
            sum +
            toCount.reduce(
              (total, payment) =>
                total + (payment.amount || donation.recurringDetails.amount),
              0
            )
          );
        }
        if (
          donation.paymentStatus === "active" ||
          donation.paymentStatus === "completed" ||
          donation.paymentStatus === "ended"
        ) {
          return sum + (donation.recurringDetails?.amount || donation.totalAmount);
        }
        return sum;
      } else {
        return sum + donation.totalAmount;
      }
    }, 0) +
    financialYearP2PDonations.reduce(
      (sum, donation) => sum + (donation.totalAmount || donation.amount || 0),
      0
    );

  return { tableData, totalDonated };
};

/**
 * Render the statement PDF and return it as a Buffer.
 * Layout is a 1:1 port of AnnualDonation.jsx.
 *
 * @param {Object} params
 * @param {Array}  params.tableData
 * @param {number} params.totalDonated
 * @param {number} params.year - END year of the FY
 * @param {Object} params.user - { name, email, id }
 * @returns {Buffer}
 */
const renderStatementPdf = ({ tableData, totalDonated, year, user }) => {
  const statementId = generateUniqueStatementId(year, user.id);

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  doc.setProperties({
    title: `Annual Donation Statement FY ${year - 1}-${year}`,
    subject: "Donation Statement",
    author: "Shahid Afridi Foundation",
    keywords: "donation, tax, statement, receipt",
    creator: "Charity Donation Platform",
  });

  const marginLeft = 20;
  const marginRight = doc.internal.pageSize.width - 20;
  const marginTop = 20;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  const logo = loadImageDataUri("logo.png");
  const taxDeductibleLogo = loadImageDataUri("tax-deductible.png");
  try {
    if (logo) doc.addImage(logo, "PNG", marginLeft, marginTop, 25, 20);
    if (taxDeductibleLogo)
      doc.addImage(taxDeductibleLogo, "PNG", marginRight - 40, marginTop, 40, 20);
  } catch (imageError) {
    console.warn("[StatementPDF] Could not add images:", imageError.message);
  }

  let yPos = marginTop + 28;

  doc.setFontSize(16);
  doc.setFont("helvetica");
  doc.text("Shahid Afridi Foundation Ltd", marginLeft, yPos);

  yPos += 7;
  doc.setFontSize(12);
  doc.text("Annual Donation Statement", marginLeft, yPos);

  yPos += 5;
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(`Financial Year: July 1, ${year - 1} - June 30, ${year}`, marginLeft, yPos);

  doc.setFontSize(10);
  doc.text("ABN: 97 642 657 010", marginRight, marginTop + 28, { align: "right" });
  doc.text(`Date Issued: ${formatDate(new Date())}`, marginRight, marginTop + 35, {
    align: "right",
  });
  doc.text(`Reference: ${statementId}`, marginRight, marginTop + 42, {
    align: "right",
  });

  yPos += 8;
  doc.setFontSize(10);
  doc.text(`Name: ${user.name || "N/A"}`, marginLeft, yPos);
  yPos += 4;
  doc.text(`Email: ${user.email || "N/A"}`, marginLeft, yPos);

  const headerData = [
    "Donation Date",
    "Donation ID",
    "Description",
    "Payment Type",
    "Donation Type",
    "Amount",
  ];

  const tableRows = tableData.map((row) => [
    row.donation_date,
    row.donation_id,
    row.description,
    row.payment_type,
    row.donation_type,
    row.amount,
  ]);

  yPos += 10;

  autoTable(doc, {
    head: [headerData],
    body: tableRows,
    startY: yPos,
    margin: { left: marginLeft, right: marginLeft },
    theme: "grid",
    styles: { font: "helvetica", fontSize: 9, textColor: 20 },
    headStyles: {
      fillColor: [240, 240, 240],
      textColor: 20,
      fontStyle: "bold",
      font: "helvetica",
      fontSize: 9,
    },
    bodyStyles: { textColor: 20, font: "helvetica", fontSize: 9 },
    columnStyles: {
      0: { cellWidth: 20 },
      1: { cellWidth: 30, fontSize: 7 },
      2: { cellWidth: 52 },
      3: { cellWidth: 18 },
      4: { cellWidth: 24 },
      5: { cellWidth: 26, halign: "right" },
    },
  });

  let lastY = doc.lastAutoTable.finalY || yPos + 10;

  const requiredHeight = 80;
  if (lastY + requiredHeight > pageHeight - 20) {
    doc.addPage();
    lastY = 40;
  }

  lastY += 15;
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text(`Total Amount: $${formatCurrency(totalDonated)}`, marginRight, lastY, {
    align: "right",
  });

  lastY += 20;
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 128, 0);
  doc.text("Tax Information", pageWidth / 2, lastY, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.setTextColor(0, 0, 0);
  doc.text(
    "All donations are tax-deductible to the extent allowed by law.",
    pageWidth / 2,
    lastY + 8,
    { align: "center" }
  );
  doc.text(
    "This statement is for tax purposes only. Please retain for your records. \n Fundraising Authority \n NSW: CFN26181 | VIC: FR0016494 | WA: CC23981 | QLD: CH4900307 | SA: CCP4771 | TAS: C/11569",
    pageWidth / 2,
    lastY + 16,
    { align: "center" }
  );

  lastY += 20;
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);

  lastY += 15;
  const footerText =
    "www.shahidafridifoundation.org.au | info@ShahidAfridiFoundation.org.au | 1300 SAF AUS (1300 723 287)";
  doc.setFontSize(8);
  doc.setTextColor(0, 0, 0);
  doc.text(footerText, pageWidth / 2, lastY, { align: "center" });

  const totalPages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(100, 100, 100);
    doc.text(`Page ${i} of ${totalPages}`, pageWidth - 20, pageHeight - 3);
  }

  return Buffer.from(doc.output("arraybuffer"));
};

module.exports = {
  buildStatementRows,
  renderStatementPdf,
  generateUniqueStatementId,
};
