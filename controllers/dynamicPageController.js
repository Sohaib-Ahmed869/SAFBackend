const DynamicPage = require("../models/dynamicPage");

// A page is "live" when it is active and the current time falls within its
// scheduled visibility window (an unset bound means unbounded on that side).
const isLive = (page) => {
  if (!page || !page.isActive) return false;
  const now = new Date();
  if (page.showFrom && now < new Date(page.showFrom)) return false;
  if (page.showUntil && now > new Date(page.showUntil)) return false;
  return true;
};

// GET /api/pages/nav — lightweight list of currently-live pages that should
// appear in the navbar. Drives the public navigation menu.
exports.getNavPages = async (_req, res) => {
  try {
    const pages = await DynamicPage.find({
      isActive: true,
      "navPlacement.type": { $ne: "none" },
    })
      .select("slug navPlacement showFrom showUntil isActive")
      .lean();

    const navItems = pages
      .filter((page) => isLive(page))
      .map((page) => ({
        slug: page.slug,
        type: page.navPlacement?.type || "none",
        dropdownParent: page.navPlacement?.dropdownParent || "",
        label: page.navPlacement?.label || page.slug,
      }));

    return res.json({ success: true, data: navItems });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch navigation pages",
      error: error.message,
    });
  }
};

// GET /api/pages/:slug — full page payload, only if the page is live.
exports.getPageBySlug = async (req, res) => {
  try {
    const slug = String(req.params.slug || "").toLowerCase();
    const page = await DynamicPage.findOne({ slug }).lean();

    if (!page || !isLive(page)) {
      return res
        .status(404)
        .json({ success: false, message: "Page not found" });
    }

    return res.json({ success: true, data: page });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch page",
      error: error.message,
    });
  }
};
